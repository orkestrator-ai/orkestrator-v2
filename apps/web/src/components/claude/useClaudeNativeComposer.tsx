import { useRef, useEffect, useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createSessionKey } from "@/lib/utils";
import { toast } from "sonner";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {useClaudeStore, type ClaudeAttachment, type QueuedMessage, type ClaudeEffortLevel} from "@/stores/claudeStore";
import { persistAgentModelDefault } from "@/lib/chat/agent-model-preferences";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import type { ClaudeModel } from "@/lib/claude-client";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import { parseSlashCommands } from "@/lib/chat/slash-commands";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { usePromptQueueDispatchRecovery } from "@/hooks/usePromptQueueDispatchRecovery";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeComposeBar } from "@/components/chat/NativeComposeBar";
import {
  createWorkspaceAttachment,
  NativeAttachmentMenu,
} from "@/components/chat/NativeAttachmentMenu";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useFileMentions } from "@/hooks/useFileMentions";
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import { useSlashCommandMenu } from "@/hooks/useSlashCommandMenu";
import { useNativeComposeSubmit } from "@/hooks/useNativeComposeSubmit";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { FileMention, FileCandidate } from "@/types";
import {
  moveAgentPrompt,
  removeAgentPrompt,
  transferAgentPromptToComposeDraft,
} from "@/lib/prompt-queue-sources";
import { composerOccupiedError } from "@/lib/prompt-queue-errors";

const EFFORT_LABELS: Record<ClaudeEffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
const EFFORT_DESCRIPTIONS: Record<ClaudeEffortLevel, string> = {
  low: "Minimal thinking, fastest responses",
  medium: "Moderate thinking for everyday tasks",
  high: "Deep reasoning for complex problems",
  xhigh: "Deeper reasoning (Opus 4.7 only)",
  max: "Maximum effort (Opus only)",
};

export interface ClaudeNativeComposerOptions {
  environmentId: string;
  /** Tab ID for multi-tab support */
  tabId: string;
  /** Container ID for containerized environments, undefined for local */
  containerId?: string;
  models: ClaudeModel[];
  onSend: (text: string, attachments: ClaudeAttachment[], effort: ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => void | Promise<void>;
  disabled?: boolean;
  /** Whether Claude is currently processing a query */
  isLoading?: boolean;
  /** Number of messages in the queue */
  queueLength?: number;
  /** Callback when stop button is clicked */
  onStop?: () => void;
  /** Callback when a message should be added to the queue */
  onQueue?: (text: string, attachments: ClaudeAttachment[], effort: ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => void | Promise<void>;
  /** Persist an explicit user mode change in the bridge-owned session. */
  onPlanModeChange?: (enabled: boolean) => void | Promise<void>;
  /** Show the review follow-up action for review workflow tabs. */
  showAddressAll?: boolean;
  layout?: "bottom" | "centered";
}

export function useClaudeNativeComposer({
  environmentId,
  tabId,
  containerId,
  models,
  onSend,
  disabled = false,
  isLoading = false,
  queueLength = 0,
  onStop,
  onQueue,
  onPlanModeChange,
  showAddressAll = false,
  layout = "bottom",
}: ClaudeNativeComposerOptions) {
  const { favorites, enabledPlatforms, toggleFavorite } = useAgentModelFavorites();
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Sampled once so a later resize across the breakpoint cannot re-run the
  // mount focus effect and steal focus from whatever the user is doing.
  const autoFocusOnMountRef = useRef(!isMobile);

  // Create sessionKey for store lookups (format: "env-{environmentId}:{tabId}")
  const sessionKey = createSessionKey(environmentId, tabId);

  // Narrow store subscriptions: actions are stable
  // references, and per-key value selectors keep unrelated store writes (other
  // sessions' drafts, transcripts, event bookkeeping) from re-rendering the bar.
  const addAttachment = useClaudeStore((state) => state.addAttachment);
  const removeAttachment = useClaudeStore((state) => state.removeAttachment);
  const clearAttachments = useClaudeStore((state) => state.clearAttachments);
  const setDraftText = useClaudeStore((state) => state.setDraftText);
  const setDraftMentions = useClaudeStore((state) => state.setDraftMentions);
  const setSelectedModel = useClaudeStore((state) => state.setSelectedModel);
  const setEffort = useClaudeStore((state) => state.setEffort);
  const setPlanMode = useClaudeStore((state) => state.setPlanMode);
  const setFastMode = useClaudeStore((state) => state.setFastMode);

  // Use a selector for sessionInitData to ensure reactivity when SSE session.init event arrives
  const sessionInitData = useClaudeStore(
    (state) => state.sessionInitData.get(environmentId)
  );

  const contextUsage = useClaudeStore(
    useCallback((state) => state.contextUsage.get(sessionKey), [sessionKey])
  );

  // Store getters return stable defaults for absent keys, so their results are
  // safe as selector outputs (no per-render churn for untouched sessions).
  const attachments = useClaudeStore(
    useCallback((state) => state.getAttachments(sessionKey), [sessionKey]),
  );
  const text = useClaudeStore(
    useCallback((state) => state.getDraftText(sessionKey), [sessionKey]),
  );
  const mentions = useClaudeStore(
    useCallback((state) => state.getDraftMentions(sessionKey), [sessionKey]),
  );
  const selectedModel = useClaudeStore(
    useCallback((state) => state.getSelectedModel(sessionKey), [sessionKey]),
  );
  const effort = useClaudeStore(
    useCallback((state) => state.getEffort(sessionKey), [sessionKey]),
  );
  const planModeEnabled = useClaudeStore(
    useCallback((state) => state.isPlanMode(sessionKey), [sessionKey]),
  );
  const fastModeEnabled = useClaudeStore(
    useCallback((state) => state.isFastMode(sessionKey), [sessionKey]),
  );
  const queuedMessages = useClaudeStore(
    useCallback((state) => state.getQueuedMessages(sessionKey), [sessionKey]),
  );
  const queueRecovery = usePromptQueueDispatchRecovery("claude", sessionKey);
  const applyPlanMode = useCallback((enabled: boolean) => {
    setPlanMode(sessionKey, enabled);
    void onPlanModeChange?.(enabled);
  }, [onPlanModeChange, sessionKey, setPlanMode]);

  // Get worktree path for local environments
  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath
  );

  // File search hook for @ mentions
  const fileSearch = useFileSearch(containerId, worktreePath);
  const { searchFiles, error: fileSearchError, refresh: refreshFileTree } = fileSearch;

  // Show toast if file search fails to load
  useEffect(() => {
    if (fileSearchError) {
      toast.error("Failed to load files for @mentions", {
        description: fileSearchError,
        duration: 4000,
      });
    }
  }, [fileSearchError]);

  // File mentions hook for @ detection and menu management
  const {
    isMenuOpen: fileMentionMenuOpen,
    selectedIndex: fileMentionSelectedIndex,
    filteredFiles,
    handleCursorChange: detectFileMention,
    handleKeyDown: handleFileMentionKeyDown,
    closeMenu: closeFileMentionMenu,
    serializeForLLM,
    createMention,
  } = useFileMentions({ searchFiles });

  // Read the send options from the store at dispatch time rather than closing
  // over this render's values — the user can flip effort, plan mode or fast
  // mode between typing and the send resolving.
  const sendWithOptions = useCallback(
    (serializedText: string, attachmentsToSend: ClaudeAttachment[]) => {
      const store = useClaudeStore.getState();
      return onSend(
        serializedText,
        attachmentsToSend,
        store.getEffort(sessionKey),
        store.isPlanMode(sessionKey),
        store.isFastMode(sessionKey),
      );
    },
    [onSend, sessionKey],
  );

  const queueWithOptions = useCallback(
    (serializedText: string, attachmentsToSend: ClaudeAttachment[]) => {
      const store = useClaudeStore.getState();
      return onQueue?.(
        serializedText,
        attachmentsToSend,
        store.getEffort(sessionKey),
        store.isPlanMode(sessionKey),
        store.isFastMode(sessionKey),
      );
    },
    [onQueue, sessionKey],
  );

  const { isSending, submit, submitPrompt } = useNativeComposeSubmit({
    agentLabel: "Claude",
    sessionKey,
    store: useClaudeStore,
    text,
    mentions,
    attachments,
    serializeForLLM,
    onSend: sendWithOptions,
    onQueue: onQueue ? queueWithOptions : undefined,
    isLoading,
    disabled,
  });

  // Track previous menu state to detect opening transition
  const prevFileMentionMenuOpen = useRef(false);

  // Refresh file tree only when @ mention menu opens (not on close)
  useEffect(() => {
    const wasOpen = prevFileMentionMenuOpen.current;
    prevFileMentionMenuOpen.current = fileMentionMenuOpen;

    // Only refresh on rising edge: menu was closed and is now opening
    if (!wasOpen && fileMentionMenuOpen) {
      refreshFileTree();
    }
  }, [fileMentionMenuOpen, refreshFileTree]);

  // Default built-in slash commands (always available)
  const defaultSlashCommands = useMemo(() => [
    "/clear - Clear conversation history",
    "/compact - Compact conversation to reduce tokens",
    "/context - Show current context",
    "/cost - Show token usage and cost",
    "/doctor - Check system health",
    "/goal - Set, view, or clear a completion goal",
    "/help - Show available commands",
    "/init - Re-initialize the session",
    "/logout - Log out of Claude",
    "/memory - Show memory usage",
    "/model - Show or change model",
    "/permissions - Manage permissions",
    "/review - Review recent changes",
    "/status - Show session status",
    "/vim - Toggle vim mode",
  ], []);

  // Parse slash commands - use session init data if available, otherwise use defaults
  const slashCommands = useMemo(
    () =>
      parseSlashCommands(
        sessionInitData?.slashCommands?.length
          ? sessionInitData.slashCommands
          : defaultSlashCommands,
      ),
    [sessionInitData?.slashCommands, defaultSlashCommands],
  );

  const setText = useCallback(
    (newText: string) => setDraftText(sessionKey, newText),
    [sessionKey, setDraftText]
  );

  const setMentions = useCallback(
    (newMentions: FileMention[]) => setDraftMentions(sessionKey, newMentions),
    [sessionKey, setDraftMentions]
  );

  // Handle text and mentions change from MentionableInput
  const handleTextAndMentionsChange = useCallback(
    (newText: string, newMentions: FileMention[]) => {
      setText(newText);
      setMentions(newMentions);
    },
    [setText, setMentions]
  );

  // Handle cursor change for @ detection
  const handleCursorPositionChange = useCallback(
    (position: number, currentText: string) => {
      detectFileMention(position, currentText);
    },
    [detectFileMention]
  );

  // Handle file mention selection
  const handleFileMentionSelect = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      closeFileMentionMenu({ suppressReopenFor: file.filename });
      inputRef.current?.insertMention(mention);
    },
    [createMention, closeFileMentionMenu]
  );

  const handleWorkspaceFileSelect = useCallback(
    (file: FileCandidate) => {
      if (disabled || isSending) {
        return;
      }
      const attachment = createWorkspaceAttachment(
        file,
        containerId,
        worktreePath,
      );
      if (!attachment) {
        toast.error("Cannot attach file", {
          description: "Environment not properly configured for attachments",
        });
        return;
      }
      addAttachment(sessionKey, attachment);
    },
    [addAttachment, containerId, disabled, isSending, sessionKey, worktreePath],
  );

  // Focus input on mount, except on mobile where it would raise the on-screen
  // keyboard over the transcript before the user has asked to type.
  useEffect(() => {
    if (autoFocusOnMountRef.current) {
      inputRef.current?.focus();
    }
  }, []);

  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  const {
    isOpen: slashMenuOpen,
    selectedIndex: slashSelectedIndex,
    filteredCommands: filteredSlashCommands,
    selectCommand: handleSlashCommandSelect,
    closeMenu: closeSlashMenu,
    handleKeyDown: handleSlashKeyDown,
  } = useSlashCommandMenu({
    commands: slashCommands,
    text,
    setText,
    focusInput,
  });

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    onAttach: useCallback(
      (attachment) => addAttachment(sessionKey, attachment),
      [addAttachment, sessionKey],
    ),
    logLabel: "useClaudeNativeComposer",
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Handle file mention menu navigation first (it takes priority over slash commands)
    if (fileMentionMenuOpen) {
      const handled = handleFileMentionKeyDown(event, handleFileMentionSelect);
      if (handled) return;
    }

    if (handleSlashKeyDown(event)) return;

    // Shift+Tab toggles between plan mode and edit mode (bypassPermissions)
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      applyPlanMode(!planModeEnabled);
      return;
    }

    // Enter to send (handled by MentionableInput for regular Enter)
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };


  const handleRemoveQueuedMessage = useCallback(
    async (messageId: string) => {
      await removeAgentPrompt("claude", sessionKey, messageId);
    },
    [sessionKey]
  );

  const handleMoveQueuedMessage = useCallback(
    async (fromIndex: number, toIndex: number) => {
      const message = queuedMessages[fromIndex];
      if (!message || Math.abs(toIndex - fromIndex) !== 1) return;
      await moveAgentPrompt(
        "claude",
        sessionKey,
        message.id,
        toIndex < fromIndex ? "up" : "down",
      );
    },
    [queuedMessages, sessionKey]
  );

  const handleQueuedMessageClick = useCallback(
    async (message: QueuedMessage) => {
      // Editing loads the prompt into the composer, so anything already there
      // would be destroyed. Refusing with a reason beats the silent overwrite
      // this used to do and beats the backend's opaque rejection downstream.
      if (text.trim().length > 0 || attachments.length > 0) {
        throw composerOccupiedError();
      }
      const removed = await transferAgentPromptToComposeDraft<QueuedMessage>(
        "claude",
        sessionKey,
        message.id,
      );
      if (!removed) return;
      clearAttachments(sessionKey);
      for (const attachment of removed.attachments) {
        addAttachment(sessionKey, attachment);
      }
      setDraftText(sessionKey, removed.text);
      setDraftMentions(sessionKey, []);
      setEffort(sessionKey, removed.effort);
      applyPlanMode(removed.planModeEnabled);
      setFastMode(sessionKey, removed.fastModeEnabled);
      setQueueDialogOpen(false);
      inputRef.current?.focus();
    },
    [text, attachments, sessionKey, clearAttachments, addAttachment, setDraftText, setDraftMentions, setEffort, applyPlanMode, setFastMode]
  );

  const handleRemoveAttachment = (id: string) => {
    removeAttachment(sessionKey, id);
  };

  // Get display name for selected model - default to first model if none selected
  const effectiveSelectedModel = selectedModel ?? models[0]?.id;
  const selectedModelObj = models.find((m) => m.id === effectiveSelectedModel);
  const selectedModelName = selectedModelObj?.name ?? models[0]?.name ?? "No models";
  const selectedModelSupportsFastMode = selectedModelObj?.supportsFastMode !== false;

  const handleModelChange = (modelId: string) => {
    setSelectedModel(sessionKey, modelId);
    void persistAgentModelDefault("claudeModel", modelId, "Claude");
    const nextModel = models.find((m) => m.id === modelId);
    if (nextModel?.supportsFastMode === false && useClaudeStore.getState().isFastMode(sessionKey)) {
      setFastMode(sessionKey, false);
    }
  };

  const handleAddressAll = () => submitPrompt(ADDRESS_ALL_REVIEW_PROMPT);

  const sendDisabled =
    disabled ||
    isSending ||
    (attachments.length === 0 && !text.trim());
  const showSendButton = !isLoading || !sendDisabled;

  // Defensively reset fast mode if the selected model doesn't support it
  // (e.g. model catalog loaded after a stale preference, or bundled defaults changed).
  useEffect(() => {
    if (selectedModelObj && !selectedModelSupportsFastMode && fastModeEnabled) {
      setFastMode(sessionKey, false);
    }
  }, [selectedModelObj, selectedModelSupportsFastMode, fastModeEnabled, sessionKey, setFastMode]);

  return (
    <NativeComposeBar
      layout={layout}
      attachments={attachments}
      onRemoveAttachment={handleRemoveAttachment}
      inputRef={inputRef}
      inputContainerRef={inputContainerRef}
      text={text}
      mentions={mentions}
      onTextAndMentionsChange={handleTextAndMentionsChange}
      onCursorPositionChange={handleCursorPositionChange}
      onKeyDown={handleKeyDown}
      placeholder="Ask Claude anything..."
      disabled={disabled}
      isSending={isSending}
      isLoading={isLoading}
      menus={
        <>
          {slashMenuOpen && filteredSlashCommands.length > 0 ? (
            <SlashCommandMenu
              commands={filteredSlashCommands}
              selectedIndex={slashSelectedIndex}
              onSelect={handleSlashCommandSelect}
              onClose={closeSlashMenu}
            />
          ) : null}
          {fileMentionMenuOpen ? (
            <FileMentionMenu
              files={filteredFiles}
              selectedIndex={fileMentionSelectedIndex}
              onSelect={handleFileMentionSelect}
              onClose={closeFileMentionMenu}
            />
          ) : null}
        </>
      }
      primaryControls={
        <>
          <NativeAttachmentMenu
            key={isSending ? "sending" : "idle"}
            disabled={disabled || isSending}
            fileSearch={fileSearch}
            onSelectFile={handleWorkspaceFileSelect}
            onCloseAutoFocus={() => inputRef.current?.focus()}
          />
          <AgentModelPicker
            favorites={favorites}
            enabledPlatforms={enabledPlatforms}
            selectedPlatform="claude"
            platformSelectionLocked
            onToggleFavorite={toggleFavorite}
            models={models.map((model) => ({
              id: model.id,
              platform: "claude",
              label: model.name,
              description: model.description,
            }))}
            selectedModelId={effectiveSelectedModel}
            selectedModelLabel={selectedModelName}
            onModelChange={handleModelChange}
            reasoningOptions={(selectedModelObj?.supportedEffortLevels
              ?? (["low", "medium", "high"] as ClaudeEffortLevel[])).map((level) => ({
                id: level,
                label: EFFORT_LABELS[level],
                description: EFFORT_DESCRIPTIONS[level],
                annotation: level === "high" ? "default" : effort === level ? "current" : undefined,
              }))}
            selectedReasoningId={effort}
            selectedReasoningLabel={EFFORT_LABELS[effort]}
            onReasoningChange={(level) => setEffort(sessionKey, level as ClaudeEffortLevel)}
            fastModeEnabled={fastModeEnabled}
            fastModeAvailable={selectedModelSupportsFastMode}
            onFastModeChange={(enabled) => setFastMode(sessionKey, enabled)}
            disabled={disabled}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={disabled}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                title="Choose mode (Shift+Tab to toggle)"
              >
                <ChevronDown className="h-3 w-3" />
                <span>{planModeEnabled ? "Plan" : "Build"}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => applyPlanMode(false)}>
                <div className="mr-2 h-4 w-4 shrink-0">
                  {!planModeEnabled ? <Check className="h-4 w-4 text-primary" /> : null}
                </div>
                Build
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => applyPlanMode(true)}>
                <div className="mr-2 h-4 w-4 shrink-0">
                  {planModeEnabled ? <Check className="h-4 w-4 text-primary" /> : null}
                </div>
                Plan
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      contextUsage={contextUsage}
      queue={{
        length: queueLength,
        error: queueRecovery.dispatchError,
        onOpen: () => setQueueDialogOpen(true),
      }}
      onStop={onStop}
      showAddressAll={showAddressAll}
      onAddressAll={handleAddressAll}
      showSendButton={showSendButton}
      sendDisabled={sendDisabled}
      onSend={submit}
      footer={
        <QueuedPromptsDialog
          open={queueDialogOpen}
          onOpenChange={setQueueDialogOpen}
          messages={queuedMessages}
          onEdit={handleQueuedMessageClick}
          onMove={handleMoveQueuedMessage}
          onRemove={handleRemoveQueuedMessage}
          dispatchError={queueRecovery.dispatchError}
          onRetryDispatch={queueRecovery.retry}
          renderMeta={(message) => (
            <>
              <span>Effort: {EFFORT_LABELS[message.effort]}</span>
              {message.planModeEnabled ? <span>Plan mode</span> : null}
              {message.fastModeEnabled ? <span>Fast mode</span> : null}
              {message.attachments.length > 0 ? (
                <span>
                  {message.attachments.length} attachment
                  {message.attachments.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </>
          )}
        />
      }
    />
  );
}

