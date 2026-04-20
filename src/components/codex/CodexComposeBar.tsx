import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, ChevronUp, FileText, Image as ImageIcon, Plus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useCodexStore } from "@/stores";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import { OpenCodeSlashCommandMenu } from "@/components/opencode/OpenCodeSlashCommandMenu";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useFileMentions, useFileSearch, useNativeComposeBarPaste } from "@/hooks";
import { toast } from "sonner";
import type { OpenCodeSlashCommand } from "@/lib/opencode-client";
import type {
  CodexConversationMode,
  CodexModel,
  CodexReasoningOption,
  CodexReasoningEffort,
  CodexSlashCommand,
} from "@/lib/codex-client";
import type { CodexAttachment, CodexQueuedMessage } from "@/stores/codexStore";
import type { FileCandidate, FileMention } from "@/types";

const MIN_HEIGHT_PX = 28;
const MAX_HEIGHT_PX = 160;
const EMPTY_ATTACHMENTS: CodexAttachment[] = [];
const EMPTY_MENTIONS: FileMention[] = [];
const EMPTY_QUEUE: CodexQueuedMessage[] = [];

const REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};
const REASONING_DESCRIPTIONS: Record<CodexReasoningEffort, string> = {
  minimal: "Shortest reasoning path for the fastest possible responses",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
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
  settingsLocked?: boolean;
  disabled?: boolean;
  isLoading?: boolean;
  queueLength?: number;
  onSend: (text: string, attachments: CodexAttachment[]) => Promise<void>;
  onQueue?: (text: string, attachments: CodexAttachment[]) => void;
  onStop?: () => Promise<void>;
  onModeChange: (mode: CodexConversationMode) => Promise<void> | void;
  onModelChange: (modelId: string) => Promise<void> | void;
  onReasoningEffortChange: (effort: CodexReasoningEffort) => Promise<void> | void;
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
}: CodexComposeBarProps) {
  const [isSending, setIsSending] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const prevFileMentionMenuOpen = useRef(false);
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
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashFilter, setSlashFilter] = useState("");
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);

  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath,
  );
  const { searchFiles, error: fileSearchError, refresh: refreshFileTree } = useFileSearch(
    containerId,
    worktreePath,
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
  } = useFileMentions({ searchFiles });

  useEffect(() => {
    inputRef.current?.focus();
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

  useEffect(() => {
    if (text.startsWith("/") && slashCommands.length > 0) {
      const spaceIndex = text.indexOf(" ");
      const currentCommand = spaceIndex === -1 ? text.slice(1) : "";

      if (spaceIndex === -1) {
        setSlashFilter(currentCommand);
        setSlashMenuOpen(true);
        setSlashSelectedIndex(0);
      } else {
        setSlashMenuOpen(false);
      }
    } else {
      setSlashMenuOpen(false);
      setSlashFilter("");
    }
  }, [slashCommands.length, text]);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || disabled) {
      return;
    }

    if (isLoading) {
      onQueue?.(serializeForLLM(trimmed, mentions), attachments);
      setDraftText(sessionKey, "");
      setDraftMentions(sessionKey, []);
      clearAttachments(sessionKey);
      return;
    }

    setIsSending(true);
    setDraftText(sessionKey, "");
    setDraftMentions(sessionKey, []);
    clearAttachments(sessionKey);
    try {
      await onSend(serializeForLLM(trimmed, mentions), attachments);
    } finally {
      setIsSending(false);
    }
  }, [
    attachments,
    clearAttachments,
    disabled,
    isLoading,
    mentions,
    onQueue,
    onSend,
    sessionKey,
    setDraftMentions,
    setDraftText,
    text,
    serializeForLLM,
  ]);

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
  const filteredSlashCommands = useMemo(
    () =>
      slashCommands.filter((command) =>
        command.name.toLowerCase().includes(slashFilter.toLowerCase()),
      ),
    [slashCommands, slashFilter],
  );

  const handleSlashCommandSelect = useCallback(
    (command: Pick<OpenCodeSlashCommand, "name">) => {
      setDraftText(sessionKey, `${command.name} `);
      setSlashMenuOpen(false);
      inputRef.current?.focus();
    },
    [sessionKey, setDraftText],
  );

  const handleTextAndMentionsChange = useCallback(
    (newText: string, newMentions: FileMention[]) => {
      setDraftText(sessionKey, newText);
      setDraftMentions(sessionKey, newMentions);
    },
    [sessionKey, setDraftMentions, setDraftText],
  );

  const handleCursorPositionChange = useCallback(
    (position: number) => {
      detectFileMention(position, text);
    },
    [detectFileMention, text],
  );

  const handleFileMentionSelect = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      inputRef.current?.insertMention(mention);
      closeFileMentionMenu();
    },
    [closeFileMentionMenu, createMention],
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        attachmentMenuRef.current
        && !attachmentMenuRef.current.contains(event.target as Node)
      ) {
        setShowAttachmentMenu(false);
      }
    }

    if (showAttachmentMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showAttachmentMenu]);

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
      removeQueueItem(sessionKey, message.id);
      setQueueDialogOpen(false);
      inputRef.current?.focus();
    },
    [addAttachment, clearAttachments, removeQueueItem, sessionKey, setDraftMentions, setDraftText],
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

  return (
    <div className="shrink-0 border-t border-border bg-background p-3">
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
                className="ml-1 rounded-full p-0.5 hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="relative" data-mentionable-input ref={inputContainerRef}>
        {slashMenuOpen && filteredSlashCommands.length > 0 ? (
          <OpenCodeSlashCommandMenu
            commands={filteredSlashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={handleSlashCommandSelect}
            onClose={() => setSlashMenuOpen(false)}
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
            if (fileMentionMenuOpen && filteredFiles.length > 0) {
              const handled = handleFileMentionKeyDown(event, (file) => {
                const mention = createMention(file);
                inputRef.current?.insertMention(mention);
              });
              if (handled) {
                return;
              }
            }

            if (slashMenuOpen && filteredSlashCommands.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashSelectedIndex((index) => (index + 1) % filteredSlashCommands.length);
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashSelectedIndex((index) =>
                  index === 0 ? filteredSlashCommands.length - 1 : index - 1,
                );
                return;
              }

              if (event.key === "Escape") {
                event.preventDefault();
                setSlashMenuOpen(false);
                return;
              }

              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const command = filteredSlashCommands[slashSelectedIndex];
                if (command) {
                  handleSlashCommandSelect(command);
                }
                return;
              }
            }

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
          minHeight={MIN_HEIGHT_PX}
          maxHeight={MAX_HEIGHT_PX}
          className={cn(disabled && "opacity-60")}
        />
      </div>

      <div className="flex items-center gap-1 pt-1">
        <div className="relative" ref={attachmentMenuRef}>
          <button
            type="button"
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            disabled={disabled}
            onClick={() => setShowAttachmentMenu((open) => !open)}
          >
            <Plus className="h-4 w-4" />
          </button>

          {showAttachmentMenu ? (
            <div className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md">
              <button
                type="button"
                className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground"
                disabled
              >
                <FileText className="h-4 w-4" />
                Attach file from workspace
              </button>
              <button
                type="button"
                className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground"
                disabled
              >
                <ImageIcon className="h-4 w-4" />
                Paste image (Cmd+V)
              </button>
            </div>
          ) : null}
        </div>

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
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={settingsLocked ? "Wait for Codex to finish before changing the model" : "Choose model"}
            >
              <ChevronDown className="h-3 w-3" />
              <span className="max-w-[220px] truncate">{selectedModelName}</span>
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
          <DropdownMenuContent align="start" className="min-w-[340px]">
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

        <div className="flex-1" />

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

        {isLoading && !text.trim() && attachments.length === 0 ? (
          <button
            type="button"
            onClick={() => {
              void onStop?.();
            }}
            disabled={disabled}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            title="Stop current query"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : (
          <Button
            type="button"
            size="icon"
            className={cn(
              "h-8 w-8 rounded-full text-foreground transition-colors",
              isLoading
                ? "bg-primary/20 text-primary hover:bg-primary/30"
                : "bg-muted hover:bg-muted/80",
            )}
            disabled={disabled || isSending || (text.trim().length === 0 && attachments.length === 0)}
            onClick={() => {
              void handleSubmit();
            }}
            title={isLoading ? "Add to queue" : "Send message"}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Dialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Queued Prompts</DialogTitle>
            <DialogDescription>
              Review pending prompts. Click one to edit it, or reorder and remove items.
            </DialogDescription>
          </DialogHeader>

          {queuedMessages.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Queue is empty.
            </div>
          ) : (
            <ScrollArea className="max-h-[380px] pr-3">
              <div className="space-y-2">
                {queuedMessages.map((message, index) => (
                  <div
                    key={message.id}
                    className="rounded-md border border-border bg-muted/20 p-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground">
                        #{index + 1}
                      </div>

                      <div className="min-w-0 flex-1">
                        <p
                          className="-mx-1 cursor-pointer rounded px-1 text-sm whitespace-pre-wrap break-words line-clamp-4 transition-colors hover:bg-muted/50"
                          onClick={() => handleQueuedMessageClick(message)}
                          title="Click to edit this message"
                        >
                          {message.text}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{message.mode === "plan" ? "Plan" : "Build"}</span>
                          <span>{message.model}</span>
                          <span>{REASONING_LABELS[message.reasoningEffort]}</span>
                          {message.attachments.length > 0 && (
                            <span>
                              {message.attachments.length} attachment
                              {message.attachments.length === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => handleMoveQueuedMessage(index, index - 1)}
                          disabled={index === 0}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          title="Move up"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveQueuedMessage(index, index + 1)}
                          disabled={index === queuedMessages.length - 1}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          title="Move down"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveQueuedMessage(message.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                          title="Remove queued prompt"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
