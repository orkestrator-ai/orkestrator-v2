import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCodexStore } from "@/stores";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeComposeBar } from "@/components/chat/NativeComposeBar";
import { NativeAttachmentMenu } from "@/components/chat/NativeAttachmentMenu";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { usePromptQueueDispatchRecovery } from "@/hooks/usePromptQueueDispatchRecovery";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useFileMentions, useFileSearch, useMediaQuery, useNativeComposeBarPaste } from "@/hooks";
import { toast } from "sonner";
import { useSlashCommandMenu } from "@/hooks/useSlashCommandMenu";
import { useNativeComposeSubmit } from "@/hooks/useNativeComposeSubmit";
import type {
  CodexConversationMode,
  CodexModel,
  CodexReasoningOption,
  CodexReasoningEffort,
  CodexSlashCommand,
} from "@/lib/codex-client";
import type { CodexAttachment, CodexQueuedMessage } from "@/stores/codexStore";
import type { FileCandidate, FileMention } from "@/types";
import {
  moveAgentPrompt,
  removeAgentPrompt,
  transferAgentPromptToComposeDraft,
} from "@/lib/prompt-queue-sources";
import { composerOccupiedError } from "@/lib/prompt-queue-errors";
import { parseCodexSteerCommand } from "./codex-steer-command";

const EMPTY_ATTACHMENTS: CodexAttachment[] = [];
const EMPTY_MENTIONS: FileMention[] = [];
const EMPTY_QUEUE: CodexQueuedMessage[] = [];

const REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
const REASONING_DESCRIPTIONS: Record<CodexReasoningEffort, string> = {
  minimal: "Shortest reasoning path for the fastest possible responses",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
};

export interface CodexNativeComposerOptions {
  environmentId: string;
  containerId?: string;
  sessionKey: string;
  models: CodexModel[];
  slashCommands?: CodexSlashCommand[];
  selectedMode: CodexConversationMode;
  selectedModel: string;
  selectedReasoningEffort: CodexReasoningEffort;
  fastModeEnabled: boolean;
  settingsLocked?: boolean;
  disabled?: boolean;
  isLoading?: boolean;
  queueLength?: number;
  onSend: (
    text: string,
    attachments: CodexAttachment[],
  ) => Promise<boolean | void>;
  onQueue?: (
    text: string,
    attachments: CodexAttachment[],
  ) => boolean | void | Promise<boolean | void>;
  onStop?: () => Promise<void>;
  onModeChange: (mode: CodexConversationMode) => Promise<void> | void;
  onModelChange: (modelId: string) => Promise<void> | void;
  onReasoningEffortChange: (effort: CodexReasoningEffort) => Promise<void> | void;
  onFastModeChange: (enabled: boolean) => void;
  /** Show the review follow-up action for review workflow tabs. */
  showAddressAll?: boolean;
  layout?: "bottom" | "centered";
}

export function useCodexNativeComposer({
  environmentId,
  containerId,
  sessionKey,
  models,
  slashCommands = [],
  selectedMode,
  selectedModel,
  selectedReasoningEffort,
  fastModeEnabled,
  settingsLocked = false,
  disabled = false,
  isLoading = false,
  queueLength = 0,
  onSend,
  onQueue,
  onStop,
  onModeChange,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  showAddressAll = false,
  layout = "bottom",
}: CodexNativeComposerOptions) {
  const { favorites, enabledPlatforms, toggleFavorite } = useAgentModelFavorites();
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const prevFileMentionMenuOpen = useRef(false);
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Sampled once so a later resize across the breakpoint cannot re-run the
  // mount focus effect and steal focus from whatever the user is doing.
  const autoFocusOnMountRef = useRef(!isMobile);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const text = useCodexStore((state) => state.draftText.get(sessionKey) ?? "");
  const mentions = useCodexStore(
    (state) => state.draftMentions.get(sessionKey) ?? EMPTY_MENTIONS,
  );
  const attachments = useCodexStore(
    (state) => state.attachments.get(sessionKey) ?? EMPTY_ATTACHMENTS,
  );
  const queuedMessages = useCodexStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey) ?? EMPTY_QUEUE,
      [sessionKey],
    ),
  );
  const queueRecovery = usePromptQueueDispatchRecovery("codex", sessionKey);
  const contextUsage = useCodexStore(
    useCallback((state) => state.contextUsage.get(sessionKey), [sessionKey]),
  );
  const setDraftText = useCodexStore((state) => state.setDraftText);
  const setDraftMentions = useCodexStore((state) => state.setDraftMentions);
  const addAttachment = useCodexStore((state) => state.addAttachment);
  const removeAttachment = useCodexStore((state) => state.removeAttachment);
  const clearAttachments = useCodexStore((state) => state.clearAttachments);

  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath,
  );
  const fileSearch = useFileSearch(
    containerId,
    worktreePath,
  );
  const { searchFiles, error: fileSearchError, refresh: refreshFileTree } = fileSearch;
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

  // Focus input on mount, except on mobile where it would raise the on-screen
  // keyboard over the transcript before the user has asked to type.
  useEffect(() => {
    if (autoFocusOnMountRef.current) {
      inputRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (fileSearchError) {
      toast.error("Failed to load files for @mentions", {
        description: fileSearchError,
        duration: 4000,
      });
    }
  }, [fileSearchError]);

  useEffect(() => {
    const wasOpen = prevFileMentionMenuOpen.current;
    prevFileMentionMenuOpen.current = fileMentionMenuOpen;
    if (!wasOpen && fileMentionMenuOpen) {
      refreshFileTree();
    }
  }, [fileMentionMenuOpen, refreshFileTree]);

  const setText = useCallback(
    (newText: string) => setDraftText(sessionKey, newText),
    [sessionKey, setDraftText],
  );

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

  const { isSending, submit: handleSubmit, submitPrompt } = useNativeComposeSubmit({
    agentLabel: "Codex",
    sessionKey,
    store: useCodexStore,
    text,
    mentions,
    attachments,
    serializeForLLM,
    onSend,
    onQueue,
    isLoading,
    disabled,
    resolveSubmitOperation: (serializedText, isQueueing) =>
      parseCodexSteerCommand(serializedText).matched
        ? "steer"
        : isQueueing
          ? "queue"
          : "send",
    // app-server rejects a second concurrent prompt with a 409.
    refuseWhenBusyWithoutQueue: true,
  });

  const handleAddressAll = useCallback(
    () => submitPrompt(ADDRESS_ALL_REVIEW_PROMPT),
    [submitPrompt],
  );

  const selectedModelObj = useMemo(
    () => models.find((model) => model.id === selectedModel),
    [models, selectedModel],
  );
  const selectedModelName = selectedModelObj?.name ?? "No models";
  const availableReasoningEfforts = useMemo(
    () =>
      selectedModelObj?.reasoningEfforts?.length
        ? selectedModelObj.reasoningEfforts
        : (["medium", "high"] as CodexReasoningEffort[]),
    [selectedModelObj],
  );
  const availableReasoningOptions = useMemo<CodexReasoningOption[]>(
    () =>
      selectedModelObj?.reasoningOptions?.length
        ? selectedModelObj.reasoningOptions
        : availableReasoningEfforts.map((effort) => ({
            effort,
            label: REASONING_LABELS[effort],
            description: REASONING_DESCRIPTIONS[effort],
          })),
    [availableReasoningEfforts, selectedModelObj],
  );
  const effectiveReasoningEffort = availableReasoningEfforts.includes(
    selectedReasoningEffort,
  )
    ? selectedReasoningEffort
    : (selectedModelObj?.defaultReasoningEffort ??
      availableReasoningEfforts[0] ??
      "medium");
  const currentReasoningOption = availableReasoningOptions.find(
    (option) => option.effort === effectiveReasoningEffort,
  );
  const reasoningDisplayLabel =
    currentReasoningOption?.label ?? REASONING_LABELS[effectiveReasoningEffort];
  const modeDisplayLabel = selectedMode === "plan" ? "Plan" : "Build";

  const handleTextAndMentionsChange = useCallback(
    (newText: string, newMentions: FileMention[]) => {
      setDraftText(sessionKey, newText);
      setDraftMentions(sessionKey, newMentions);
    },
    [sessionKey, setDraftMentions, setDraftText],
  );

  const handleCursorPositionChange = useCallback(
    (position: number, currentText: string) => {
      detectFileMention(position, currentText);
    },
    [detectFileMention],
  );

  const handleFileMentionSelect = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      closeFileMentionMenu({ suppressReopenFor: file.filename });
      inputRef.current?.insertMention(mention);
    },
    [closeFileMentionMenu, createMention],
  );

  const handleWorkspaceFileSelect = useCallback(
    (file: FileCandidate) => {
      if (disabled || isSending) {
        return;
      }
      const mention = createMention(file);
      closeFileMentionMenu({ suppressReopenFor: file.filename });
      inputRef.current?.insertMentionAtCursor(mention);
    },
    [closeFileMentionMenu, createMention, disabled, isSending],
  );

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    onAttach: useCallback(
      (attachment) => addAttachment(sessionKey, attachment),
      [addAttachment, sessionKey],
    ),
    logLabel: "useCodexNativeComposer",
  });

  const handleQueuedMessageClick = useCallback(
    async (message: CodexQueuedMessage) => {
      // Editing loads the prompt into the composer, so anything already there
      // would be destroyed. Refusing with a reason beats the silent overwrite
      // this used to do and beats the backend's opaque rejection downstream.
      if (text.trim().length > 0 || attachments.length > 0) {
        throw composerOccupiedError();
      }
      const removed = await transferAgentPromptToComposeDraft<CodexQueuedMessage>(
        "codex",
        sessionKey,
        message.id,
      );
      if (!removed) return;
      setDraftText(sessionKey, removed.text);
      setDraftMentions(sessionKey, []);
      clearAttachments(sessionKey);
      for (const attachment of removed.attachments) {
        addAttachment(sessionKey, attachment);
      }
      if (removed.fastMode !== fastModeEnabled) {
        onFastModeChange(removed.fastMode);
      }
      setQueueDialogOpen(false);
      inputRef.current?.focus();
    },
    [
      addAttachment,
      attachments,
      clearAttachments,
      fastModeEnabled,
      onFastModeChange,
      sessionKey,
      setDraftMentions,
      setDraftText,
      text,
    ],
  );

  const handleMoveQueuedMessage = useCallback(
    async (fromIndex: number, toIndex: number) => {
      const message = queuedMessages[fromIndex];
      if (!message || Math.abs(toIndex - fromIndex) !== 1) return;
      await moveAgentPrompt(
        "codex",
        sessionKey,
        message.id,
        toIndex < fromIndex ? "up" : "down",
      );
    },
    [queuedMessages, sessionKey],
  );

  const handleRemoveQueuedMessage = useCallback(
    async (messageId: string) => {
      await removeAgentPrompt("codex", sessionKey, messageId);
    },
    [sessionKey],
  );

  const sendDisabled =
    disabled ||
    isSending ||
    (isLoading && !onQueue) ||
    (text.trim().length === 0 && attachments.length === 0);
  const showSendButton = !isLoading || !sendDisabled;
  const steerCommand = parseCodexSteerCommand(text);
  const isSteering = isLoading && steerCommand.matched && steerCommand.input.length > 0;
  const needsSteerInstructions = isLoading && steerCommand.matched && !steerCommand.input;

  return (
    <NativeComposeBar
      layout={layout}
      attachments={attachments}
      onRemoveAttachment={(attachmentId) => removeAttachment(sessionKey, attachmentId)}
      inputRef={inputRef}
      inputContainerRef={inputContainerRef}
      text={text}
      mentions={mentions}
      onTextAndMentionsChange={handleTextAndMentionsChange}
      onCursorPositionChange={handleCursorPositionChange}
      onKeyDown={(event) => {
        if (fileMentionMenuOpen) {
          const handled = handleFileMentionKeyDown(event, handleFileMentionSelect);
          if (handled) return;
        }
        if (handleSlashKeyDown(event)) return;
        if (event.key === "Tab" && event.shiftKey) {
          event.preventDefault();
          void onModeChange(selectedMode === "plan" ? "build" : "plan");
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void handleSubmit();
        }
      }}
      placeholder="Ask Codex anything..."
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
            fileActionLabel="Mention file from workspace"
            filePickerTitle="Mention workspace file"
            filePickerDescription="Search this environment and mention a file in the current prompt."
          />
          <AgentModelPicker
            favorites={favorites}
            enabledPlatforms={enabledPlatforms}
            selectedPlatform="codex"
            platformSelectionLocked
            onToggleFavorite={toggleFavorite}
            models={models.map((model) => ({
              id: model.id,
              platform: "codex",
              label: model.name,
              description: model.description,
            }))}
            selectedModelId={selectedModel}
            selectedModelLabel={selectedModelName}
            onModelChange={(modelId) => void onModelChange(modelId)}
            reasoningOptions={availableReasoningOptions.map((option) => ({
              id: option.effort,
              label: option.label,
              description: option.description,
              annotation: selectedModelObj?.defaultReasoningEffort === option.effort
                ? "default"
                : effectiveReasoningEffort === option.effort
                  ? "current"
                  : undefined,
            }))}
            selectedReasoningId={effectiveReasoningEffort}
            selectedReasoningLabel={reasoningDisplayLabel}
            onReasoningChange={(effort) => {
              void onReasoningEffortChange(effort as CodexReasoningEffort);
            }}
            fastModeEnabled={fastModeEnabled}
            fastModeAvailable
            onFastModeChange={onFastModeChange}
            disabled={disabled || settingsLocked}
            title={settingsLocked
              ? "Wait for Codex to finish before changing model settings"
              : "Choose model, reasoning, and speed"}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled || settingsLocked}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                title={settingsLocked
                  ? "Wait for Codex to finish before changing the mode"
                  : "Choose mode"}
              >
                <ChevronDown className="h-3 w-3" />
                <span>{modeDisplayLabel}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void onModeChange("build")} disabled={settingsLocked}>
                Build
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void onModeChange("plan")} disabled={settingsLocked}>
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
      sendTitle={isSteering
        ? "Send to current turn"
        : needsSteerInstructions
          ? "Add instructions after /steer"
          : isLoading
            ? "Add to queue"
            : "Send message"}
      onSend={handleSubmit}
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
              <span>{message.mode === "plan" ? "Plan" : "Build"}</span>
              <span>{message.model}</span>
              <span>{REASONING_LABELS[message.reasoningEffort]}</span>
              {message.fastMode ? <span>Fast mode</span> : null}
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


