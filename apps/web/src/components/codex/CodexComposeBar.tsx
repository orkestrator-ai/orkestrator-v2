import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, FileText, Square, X, Zap } from "lucide-react";
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
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeAttachmentMenu } from "@/components/chat/NativeAttachmentMenu";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
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
  const setDraftText = useCodexStore((state) => state.setDraftText);
  const setDraftMentions = useCodexStore((state) => state.setDraftMentions);
  const addAttachment = useCodexStore((state) => state.addAttachment);
  const removeAttachment = useCodexStore((state) => state.removeAttachment);
  const clearAttachments = useCodexStore((state) => state.clearAttachments);
  const removeQueueItem = useCodexStore((state) => state.removeQueueItem);
  const moveQueueItem = useCodexStore((state) => state.moveQueueItem);

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
    (message: CodexQueuedMessage) => {
      setDraftText(sessionKey, message.text);
      setDraftMentions(sessionKey, []);
      clearAttachments(sessionKey);
      for (const attachment of message.attachments) {
        addAttachment(sessionKey, attachment);
      }
      if (message.fastMode !== fastModeEnabled) {
        onFastModeChange(message.fastMode);
      }
      removeQueueItem(sessionKey, message.id);
      setQueueDialogOpen(false);
      inputRef.current?.focus();
    },
    [
      addAttachment,
      clearAttachments,
      fastModeEnabled,
      onFastModeChange,
      removeQueueItem,
      sessionKey,
      setDraftMentions,
      setDraftText,
    ],
  );

  const handleMoveQueuedMessage = useCallback(
    (fromIndex: number, toIndex: number) => {
      moveQueueItem(sessionKey, fromIndex, toIndex);
    },
    [moveQueueItem, sessionKey],
  );

  const handleRemoveQueuedMessage = useCallback(
    (messageId: string) => {
      removeQueueItem(sessionKey, messageId);
    },
    [removeQueueItem, sessionKey],
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
        className="flex flex-col gap-1 overflow-x-auto pt-1 [scrollbar-width:none] [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden sm:flex-row sm:items-center"
      >
        <div
          data-native-compose-controls="primary"
          className="flex w-full min-w-0 items-center gap-1 sm:w-auto"
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || settingsLocked}
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
              title={settingsLocked ? "Wait for Codex to finish before changing the model" : "Choose model"}
            >
              <ChevronDown className="h-3 w-3" />
              <span className="min-w-0 max-w-full truncate sm:max-w-[220px]">{selectedModelName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[260px] max-h-[360px] overflow-y-auto">
            {models.length === 0 ? (
              <DropdownMenuItem disabled>No models available</DropdownMenuItem>
            ) : (
              models.map((model) => {
                const isSelected = model.id === selectedModel;
                return (
                  <DropdownMenuItem
                    key={model.id}
                    onClick={() => void onModelChange(model.id)}
                    disabled={settingsLocked}
                    className="flex items-start gap-2 py-2"
                  >
                    <div className="mt-0.5 h-4 w-4 shrink-0">
                      {isSelected ? <Check className="h-4 w-4 text-primary" /> : null}
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{model.name}</span>
                      {model.description ? (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {model.description}
                        </span>
                      ) : null}
                    </div>
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || settingsLocked}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={settingsLocked ? "Wait for Codex to finish before changing reasoning" : "Choose reasoning effort"}
            >
              <ChevronDown className="h-3 w-3" />
              <span>{reasoningDisplayLabel}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[calc(100vw-1rem)] sm:min-w-[340px] sm:w-auto">
            {availableReasoningOptions.map((option) => (
              <DropdownMenuItem
                key={option.effort}
                onClick={() => void onReasoningEffortChange(option.effort)}
                disabled={settingsLocked}
                className="flex items-start gap-2 py-2"
              >
                <div className="mt-0.5 h-4 w-4 shrink-0">
                  {effectiveReasoningEffort === option.effort ? (
                    <Check className="h-4 w-4 text-primary" />
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">
                    {option.label}
                    {selectedModelObj?.defaultReasoningEffort === option.effort
                      ? " (default)"
                      : ""}
                    {effectiveReasoningEffort === option.effort
                      && selectedModelObj?.defaultReasoningEffort !== option.effort
                      ? " (current)"
                      : ""}
                  </span>
                  {option.description ? (
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Fast mode toggle — maps to Codex's `service_tier = fast` config. */}
        <button
          type="button"
          disabled={disabled || settingsLocked}
          onClick={() => onFastModeChange(!fastModeEnabled)}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            fastModeEnabled
              ? "bg-amber-500/10 text-amber-500 hover:bg-amber-500/15 hover:text-amber-400"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
          title={
            fastModeEnabled
              ? "Fast mode on — ~1.5x faster, higher credit rate"
              : "Enable fast mode (~1.5x faster, higher credit rate)"
          }
          aria-pressed={fastModeEnabled}
        >
          <Zap className={cn("h-3 w-3", fastModeEnabled && "fill-current")} />
          <span>Fast</span>
        </button>

        </div>

        <div
          data-native-compose-controls="secondary"
          className="flex w-full items-center gap-1 sm:ml-auto sm:w-auto"
        >
        <div className="flex-1 sm:hidden" />

        {queueLength > 0 && (
          <button
            type="button"
            onClick={() => setQueueDialogOpen(true)}
            className="flex items-center gap-1 rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
            title="View queued prompts"
          >
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
