import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowUp, ChevronDown, FileText, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useCodexStore } from "@/stores";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { ContextUsageWheel } from "@/components/chat/ContextUsageWheel";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeAttachmentMenu } from "@/components/chat/NativeAttachmentMenu";
import { NativeModelPicker } from "@/components/chat/NativeModelPicker";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { usePromptQueueDispatchRecovery } from "@/hooks/usePromptQueueDispatchRecovery";
import {
  COMPOSE_MAX_INPUT_HEIGHT,
  COMPOSE_MIN_INPUT_HEIGHT,
} from "@/components/chat/compose-metrics";
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

interface CodexComposeBarProps {
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
  onSend: (text: string, attachments: CodexAttachment[]) => Promise<void>;
  onQueue?: (text: string, attachments: CodexAttachment[]) => void | Promise<void>;
  onStop?: () => Promise<void>;
  onModeChange: (mode: CodexConversationMode) => Promise<void> | void;
  onModelChange: (modelId: string) => Promise<void> | void;
  onReasoningEffortChange: (effort: CodexReasoningEffort) => Promise<void> | void;
  onFastModeChange: (enabled: boolean) => void;
  /** Show the review follow-up action for review workflow tabs. */
  showAddressAll?: boolean;
  layout?: "bottom" | "centered";
}

export function CodexComposeBar({
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
}: CodexComposeBarProps) {
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
    logLabel: "CodexComposeBar",
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

  return (
    <div
      className={cn(
        "mx-auto w-[calc(100%_-_0.75rem)] shrink-0 rounded-2xl border border-border/70 bg-zinc-900/90 p-3 shadow-xl shadow-black/20 sm:w-[min(calc(100%_-_2rem),56rem)]",
        layout === "bottom" ? "mb-4 mt-2" : "my-0",
      )}
    >
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="relative flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1 text-xs"
            >
              {attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-6 w-6 rounded object-cover"
                />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="max-w-[120px] truncate">{attachment.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(sessionKey, attachment.id)}
                disabled={disabled || isSending}
                className="ml-1 rounded-full p-0.5 hover:bg-muted"
                aria-label={`Remove ${attachment.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="relative" data-mentionable-input ref={inputContainerRef}>
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

        <MentionableInput
          ref={inputRef}
          value={text}
          mentions={mentions}
          onChange={handleTextAndMentionsChange}
          onCursorChange={handleCursorPositionChange}
          onKeyDown={(event) => {
            if (fileMentionMenuOpen) {
              const handled = handleFileMentionKeyDown(event, handleFileMentionSelect);
              if (handled) {
                return;
              }
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
          disabled={disabled || isSending}
          minHeight={COMPOSE_MIN_INPUT_HEIGHT}
          maxHeight={COMPOSE_MAX_INPUT_HEIGHT}
          className={cn((disabled || isSending) && "opacity-60")}
        />
      </div>

      <div
        data-native-compose-toolbar
        className="flex min-w-0 items-center gap-1 overflow-x-auto pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div
          data-native-compose-controls="primary"
          className="flex min-w-0 flex-1 items-center gap-1"
        >
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || settingsLocked}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={settingsLocked ? "Wait for Codex to finish before changing the mode" : "Choose mode"}
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

        <NativeModelPicker
          models={models.map((model) => ({
            id: model.id,
            label: model.name,
            description: model.description,
          }))}
          selectedModelId={selectedModel}
          selectedModelLabel={selectedModelName}
          onModelChange={(modelId) => { void onModelChange(modelId); }}
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
          title={
            settingsLocked
              ? "Wait for Codex to finish before changing model settings"
              : "Choose model, reasoning, and speed"
          }
        />

        </div>

        <div
          data-native-compose-controls="secondary"
          className="flex shrink-0 items-center gap-1"
        >
        {!isMobile && <ContextUsageWheel usage={contextUsage} className="ml-1" />}

        {/* A parked queue stops draining until a human retries, so the failure
            has to be legible without opening the dialog. */}
        {queueLength > 0 && (
          <button
            type="button"
            onClick={() => setQueueDialogOpen(true)}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
              queueRecovery.dispatchError
                ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                : "bg-muted/50 text-muted-foreground hover:bg-muted",
            )}
            aria-label={
              queueRecovery.dispatchError
                ? `${queueLength} queued prompts blocked: ${queueRecovery.dispatchError.message}`
                : undefined
            }
            title={
              queueRecovery.dispatchError
                ? `Queued prompt was not sent: ${queueRecovery.dispatchError.message}`
                : "View queued prompts"
            }
          >
            {queueRecovery.dispatchError && (
              <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <span>+{queueLength} queued</span>
          </button>
        )}

        {isLoading ? (
          <button
            type="button"
            onClick={() => {
              void onStop?.();
            }}
            disabled={disabled || !onStop}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            title="Stop current query"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : null}

        {showAddressAll && !isLoading ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              void handleAddressAll();
            }}
            disabled={disabled || isSending}
            className="h-8 rounded-full px-3 text-xs"
            title="Send the review follow-up prompt"
          >
            Address all
          </Button>
        ) : null}

        {showSendButton ? (
          <Button
            type="button"
            size="icon"
            className={cn(
              "h-8 w-8 rounded-full text-foreground transition-colors",
              isLoading
                ? "bg-primary/20 text-primary hover:bg-primary/30"
                : "bg-muted hover:bg-muted/80",
            )}
            disabled={sendDisabled}
            onClick={() => {
              void handleSubmit();
            }}
            title={isLoading ? "Add to queue" : "Send message"}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        ) : null}
        </div>
      </div>

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
            {message.fastMode && <span>Fast mode</span>}
            {message.attachments.length > 0 && (
              <span>
                {message.attachments.length} attachment
                {message.attachments.length === 1 ? "" : "s"}
              </span>
            )}
          </>
        )}
      />
    </div>
  );
}
