import { useRef, useState, useEffect, useCallback, type KeyboardEvent } from "react";
import { X, Plus, FileText, Image as ImageIcon, ChevronDown, ChevronUp, ArrowUp, Check, Square, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useClaudeStore, createClaudeSessionKey, type ClaudeAttachment, type QueuedMessage, type ClaudeEffortLevel } from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { ContextUsageWheel } from "@/components/chat/ContextUsageWheel";
import { updateGlobalConfig as persistGlobalConfig } from "@/lib/backend";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import type { ClaudeModel } from "@/lib/claude-client";
import { SlashCommandMenu, parseSlashCommands } from "./SlashCommandMenu";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useFileMentions } from "@/hooks/useFileMentions";
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import type { FileMention, FileCandidate } from "@/types";

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

interface ClaudeComposeBarProps {
  environmentId: string;
  /** Tab ID for multi-tab support */
  tabId: string;
  /** Container ID for containerized environments, undefined for local */
  containerId?: string;
  models: ClaudeModel[];
  onSend: (text: string, attachments: ClaudeAttachment[], effort: ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => void;
  disabled?: boolean;
  /** Whether Claude is currently processing a query */
  isLoading?: boolean;
  /** Number of messages in the queue */
  queueLength?: number;
  /** Callback when stop button is clicked */
  onStop?: () => void;
  /** Callback when a message should be added to the queue */
  onQueue?: (text: string, attachments: ClaudeAttachment[], effort: ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => void;
  /** Show the review follow-up action for review workflow tabs. */
  showAddressAll?: boolean;
  layout?: "bottom" | "centered";
}

const MAX_LINES = 12;
const LINE_HEIGHT = 20;

export function ClaudeComposeBar({
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
  showAddressAll = false,
  layout = "bottom",
}: ClaudeComposeBarProps) {
  const [isSending, setIsSending] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);

  // Create sessionKey for store lookups (format: "env-{environmentId}:{tabId}")
  const sessionKey = createClaudeSessionKey(environmentId, tabId);

  const {
    getAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    getDraftText,
    setDraftText,
    getDraftMentions,
    setDraftMentions,
    getSelectedModel,
    setSelectedModel,
    getEffort,
    setEffort,
    isPlanMode,
    setPlanMode,
    isFastMode,
    setFastMode,
    getQueuedMessages,
    removeQueueItem,
    moveQueueItem,
  } = useClaudeStore();

  // Use a selector for sessionInitData to ensure reactivity when SSE session.init event arrives
  const sessionInitData = useClaudeStore(
    (state) => state.sessionInitData.get(environmentId)
  );

  const contextUsage = useClaudeStore(
    useCallback((state) => state.contextUsage.get(sessionKey), [sessionKey])
  );

  const attachments = getAttachments(sessionKey);
  const text = getDraftText(sessionKey);
  const mentions = getDraftMentions(sessionKey);
  const selectedModel = getSelectedModel(sessionKey);
  const effort = getEffort(sessionKey);
  const planModeEnabled = isPlanMode(sessionKey);
  const fastModeEnabled = isFastMode(sessionKey);
  const queuedMessages = getQueuedMessages(sessionKey);

  // Get worktree path for local environments
  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath
  );

  // File search hook for @ mentions
  const { searchFiles, error: fileSearchError, refresh: refreshFileTree } = useFileSearch(containerId, worktreePath);

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

  // Slash command menu state
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashFilter, setSlashFilter] = useState("");

  // Default built-in slash commands (always available)
  const defaultSlashCommands = [
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
  ];

  // Parse slash commands - use session init data if available, otherwise use defaults
  const slashCommands = parseSlashCommands(
    sessionInitData?.slashCommands?.length ? sessionInitData.slashCommands : defaultSlashCommands
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

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Detect "/" being typed to show slash command menu
  useEffect(() => {
    if (text.startsWith("/") && slashCommands.length > 0) {
      // Extract the command being typed (everything after /)
      const spaceIndex = text.indexOf(" ");
      const currentCommand = spaceIndex === -1 ? text.slice(1) : "";

      // Only show menu if we haven't completed typing a command yet (no space)
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
  }, [text, slashCommands.length]);

  // Filter slash commands based on current input
  const filteredSlashCommands = slashCommands.filter((cmd) =>
    cmd.name.toLowerCase().includes(slashFilter.toLowerCase())
  );

  // Handle slash command selection
  const handleSlashCommandSelect = useCallback(
    (command: { name: string }) => {
      // Replace the current "/" + filter with the selected command + space
      setText(command.name + " ");
      setSlashMenuOpen(false);
      inputRef.current?.focus();
    },
    [setText]
  );

  // Close attachment menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        attachmentMenuRef.current &&
        !attachmentMenuRef.current.contains(event.target as Node)
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
    logLabel: "ClaudeComposeBar",
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Handle file mention menu navigation first (it takes priority over slash commands)
    if (fileMentionMenuOpen) {
      const handled = handleFileMentionKeyDown(event, handleFileMentionSelect);
      if (handled) return;
    }

    // Handle slash command menu navigation
    if (slashMenuOpen && filteredSlashCommands.length > 0) {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSlashSelectedIndex((prev) =>
            prev < filteredSlashCommands.length - 1 ? prev + 1 : prev
          );
          return;
        case "ArrowUp":
          event.preventDefault();
          setSlashSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          return;
        case "Tab":
        case "Enter":
          if (filteredSlashCommands[slashSelectedIndex]) {
            event.preventDefault();
            handleSlashCommandSelect(filteredSlashCommands[slashSelectedIndex]);
            return;
          }
          break;
        case "Escape":
          event.preventDefault();
          setSlashMenuOpen(false);
          return;
      }
    }

    // Shift+Tab toggles between plan mode and edit mode (bypassPermissions)
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      setPlanMode(sessionKey, !planModeEnabled);
    }

    // Enter to send (handled by MentionableInput for regular Enter)
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    if (isSending || disabled) return;
    if (attachments.length === 0 && !text.trim()) return;

    setIsSending(true);
    try {
      // Read current values directly from store to avoid stale closures
      const currentEffort = getEffort(sessionKey);
      const currentPlanModeEnabled = isPlanMode(sessionKey);
      const currentFastModeEnabled = isFastMode(sessionKey);

      // Serialize mentions: replace @filename with full relative path
      const serializedText = serializeForLLM(text.trim(), mentions);

      // If loading and onQueue is provided, add to queue instead of sending immediately
      if (isLoading && onQueue) {
        onQueue(serializedText, attachments, currentEffort, currentPlanModeEnabled, currentFastModeEnabled);
      } else {
        onSend(serializedText, attachments, currentEffort, currentPlanModeEnabled, currentFastModeEnabled);
      }
      setText("");
      setMentions([]);
      clearAttachments(sessionKey);
    } finally {
      setIsSending(false);
    }
  };

  const handleStop = () => {
    if (onStop) {
      onStop();
    }
  };

  const handleRemoveQueuedMessage = useCallback(
    (messageId: string) => {
      removeQueueItem(sessionKey, messageId);
    },
    [removeQueueItem, sessionKey]
  );

  const handleMoveQueuedMessage = useCallback(
    (fromIndex: number, toIndex: number) => {
      moveQueueItem(sessionKey, fromIndex, toIndex);
    },
    [moveQueueItem, sessionKey]
  );

  const handleQueuedMessageClick = useCallback(
    (message: QueuedMessage) => {
      removeQueueItem(sessionKey, message.id);
      clearAttachments(sessionKey);
      for (const attachment of message.attachments) {
        addAttachment(sessionKey, attachment);
      }
      setDraftText(sessionKey, message.text);
      setDraftMentions(sessionKey, []);
      setEffort(sessionKey, message.effort);
      setPlanMode(sessionKey, message.planModeEnabled);
      setFastMode(sessionKey, message.fastModeEnabled);
      setQueueDialogOpen(false);
      inputRef.current?.focus();
    },
    [removeQueueItem, sessionKey, clearAttachments, addAttachment, setDraftText, setDraftMentions, setEffort, setPlanMode, setFastMode]
  );

  const handleRemoveAttachment = (id: string) => {
    removeAttachment(sessionKey, id);
  };

  // Get display name for selected model - default to first model if none selected
  const effectiveSelectedModel = selectedModel ?? models[0]?.id;
  const selectedModelObj = models.find((m) => m.id === effectiveSelectedModel);
  const selectedModelName = selectedModelObj?.name ?? (models.length > 0 ? models[0]?.name : "No models");
  const selectedModelSupportsFastMode = selectedModelObj?.supportsFastMode !== false;

  const persistClaudeModelDefault = useCallback(async (modelId: string) => {
    const currentConfig = useConfigStore.getState().config;
    if (currentConfig.global.claudeModel === modelId) return;

    const nextGlobal = { ...currentConfig.global, claudeModel: modelId };
    useConfigStore.getState().setConfig({
      ...currentConfig,
      global: nextGlobal,
    });

    try {
      const updatedConfig = await persistGlobalConfig(nextGlobal);
      if (useConfigStore.getState().config.global.claudeModel === modelId) {
        useConfigStore.getState().setConfig(updatedConfig);
      }
    } catch (error) {
      if (useConfigStore.getState().config.global.claudeModel === modelId) {
        useConfigStore.getState().setConfig(currentConfig);
      }
      console.error("[ClaudeComposeBar] Failed to persist Claude model default:", error);
      toast.error("Failed to save Claude model default");
    }
  }, []);

  const handleModelChange = (modelId: string) => {
    setSelectedModel(sessionKey, modelId);
    void persistClaudeModelDefault(modelId);
    const nextModel = models.find((m) => m.id === modelId);
    if (nextModel?.supportsFastMode === false && isFastMode(sessionKey)) {
      setFastMode(sessionKey, false);
    }
  };

  const handleAddressAll = () => {
    if (disabled || isSending || isLoading) return;
    setIsSending(true);
    try {
      onSend(
        ADDRESS_ALL_REVIEW_PROMPT,
        [],
        effort,
        planModeEnabled,
        fastModeEnabled,
      );
    } finally {
      setIsSending(false);
    }
  };

  // Defensively reset fast mode if the selected model doesn't support it
  // (e.g. model catalog loaded after a stale preference, or bundled defaults changed).
  useEffect(() => {
    if (selectedModelObj && !selectedModelSupportsFastMode && fastModeEnabled) {
      setFastMode(sessionKey, false);
    }
  }, [selectedModelObj, selectedModelSupportsFastMode, fastModeEnabled, sessionKey, setFastMode]);

  return (
    <div
      className={cn(
        "mx-auto w-[calc(100%_-_0.75rem)] shrink-0 rounded-2xl border border-border/70 bg-zinc-900/90 p-3 shadow-xl shadow-black/20 sm:w-[min(calc(100%_-_2rem),56rem)]",
        layout === "bottom" ? "mb-4 mt-2" : "my-0",
      )}
    >
      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="relative group flex items-center gap-1.5 px-2 py-1 rounded bg-muted/50 border border-border text-xs"
            >
              {att.type === "image" && att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="w-6 h-6 object-cover rounded"
                />
              ) : (
                <FileText className="w-4 h-4 text-muted-foreground" />
              )}
              <span className="max-w-[120px] truncate">{att.name}</span>
              <button
                onClick={() => handleRemoveAttachment(att.id)}
                className="ml-1 p-0.5 rounded-full hover:bg-muted"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Text input area container with menus */}
      <div className="relative" data-mentionable-input ref={inputContainerRef}>
        {/* Slash command menu - appears above input */}
        {slashMenuOpen && filteredSlashCommands.length > 0 && (
          <SlashCommandMenu
            commands={filteredSlashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={handleSlashCommandSelect}
            onClose={() => setSlashMenuOpen(false)}
          />
        )}

        {/* File mention menu - appears above input */}
        {fileMentionMenuOpen && (
          <FileMentionMenu
            files={filteredFiles}
            selectedIndex={fileMentionSelectedIndex}
            onSelect={handleFileMentionSelect}
            onClose={closeFileMentionMenu}
          />
        )}

        {/* Mentionable input with @ file references */}
        <MentionableInput
          ref={inputRef}
          value={text}
          mentions={mentions}
          onChange={handleTextAndMentionsChange}
          onCursorChange={handleCursorPositionChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask Claude anything..."
          disabled={disabled || isSending}
          minHeight={LINE_HEIGHT + 8}
          maxHeight={MAX_LINES * LINE_HEIGHT + 16}
        />
      </div>

      {/* Bottom toolbar row */}
      <div className="flex items-center gap-1 overflow-x-auto pt-1 [scrollbar-width:none] [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden">
        {/* Attachment button */}
        <div className="relative" ref={attachmentMenuRef}>
          <button
            className="p-1.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
            disabled={disabled}
            onClick={() => setShowAttachmentMenu(!showAttachmentMenu)}
          >
            <Plus className="w-4 h-4" />
          </button>

          {/* Attachment menu popover */}
          {showAttachmentMenu && (
            <div className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-xl border border-zinc-700/70 bg-zinc-900/95 p-1 shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-sm">
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-zinc-800/70 hover:text-foreground"
                onClick={() => {
                  setShowAttachmentMenu(false);
                }}
              >
                <FileText className="w-4 h-4" />
                Attach file from workspace
              </button>
              <button
                className="flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground"
                disabled
              >
                <ImageIcon className="w-4 h-4" />
                Paste image (Cmd+V)
              </button>
            </div>
          )}
        </div>

        {/* Model dropdown - minimal style */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
              <ChevronDown className="w-3 h-3" />
              <span className="max-w-[200px] truncate">{selectedModelName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[400px] overflow-y-auto min-w-[240px]">
            {models.length === 0 ? (
              <DropdownMenuItem disabled>No models available</DropdownMenuItem>
            ) : (
              models.map((model) => {
                const isSelected = model.id === effectiveSelectedModel;
                return (
                  <DropdownMenuItem
                    key={model.id}
                    onClick={() => handleModelChange(model.id)}
                    className="flex items-start gap-2 py-2"
                  >
                    <div className="w-4 h-4 flex-shrink-0 mt-0.5">
                      {isSelected && <Check className="w-4 h-4 text-primary" />}
                    </div>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium truncate">{model.name}</span>
                      {model.description && (
                        <span className="text-xs text-muted-foreground line-clamp-2">{model.description}</span>
                      )}
                    </div>
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Plan/Build mode dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={disabled}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              title="Choose mode (Shift+Tab to toggle)"
            >
              <ChevronDown className="w-3 h-3" />
              <span>{planModeEnabled ? "Plan" : "Build"}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => setPlanMode(sessionKey, false)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {!planModeEnabled && <Check className="w-4 h-4 text-primary" />}
              </div>
              Build
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPlanMode(sessionKey, true)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {planModeEnabled && <Check className="w-4 h-4 text-primary" />}
              </div>
              Plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Effort level dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={disabled}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              title="Choose effort level"
            >
              <ChevronDown className="w-3 h-3" />
              <span>{EFFORT_LABELS[effort]}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[calc(100vw-1rem)] sm:min-w-[340px] sm:w-auto">
            {(selectedModelObj?.supportedEffortLevels ?? (["low", "medium", "high"] as ClaudeEffortLevel[])).map((level) => (
              <DropdownMenuItem
                key={level}
                onClick={() => setEffort(sessionKey, level)}
                className="flex items-start gap-2 py-2"
              >
                <div className="w-4 h-4 shrink-0 mt-0.5">
                  {effort === level && <Check className="w-4 h-4 text-primary" />}
                </div>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium">
                    {EFFORT_LABELS[level]}
                    {level === "high" ? " (default)" : ""}
                    {effort === level && level !== "high" ? " (current)" : ""}
                  </span>
                  <span className="text-xs text-muted-foreground line-clamp-2">
                    {EFFORT_DESCRIPTIONS[level]}
                  </span>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Fast mode toggle — only shown when the selected model supports it. */}
        {selectedModelSupportsFastMode && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setFastMode(sessionKey, !fastModeEnabled)}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
              fastModeEnabled
                ? "text-amber-500 hover:text-amber-400 bg-amber-500/10 hover:bg-amber-500/15"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
            title={
              fastModeEnabled
                ? "Fast mode on — lower latency, higher credit rate"
                : "Enable fast mode (lower latency, higher credit rate)"
            }
            aria-pressed={fastModeEnabled}
          >
            <Zap className={cn("w-3 h-3", fastModeEnabled && "fill-current")} />
            <span>Fast</span>
          </button>
        )}

        <ContextUsageWheel usage={contextUsage} className="ml-1" />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Queue indicator */}
        {queueLength > 0 && (
          <button
            type="button"
            onClick={() => setQueueDialogOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground bg-muted/50 hover:bg-muted transition-colors"
            title="View queued prompts"
          >
            <span>+{queueLength} queued</span>
          </button>
        )}

        {showAddressAll && !isLoading && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleAddressAll}
            disabled={disabled || isSending}
            className="h-8 rounded-full px-3 text-xs"
            title="Send the review follow-up prompt"
          >
            Address all
          </Button>
        )}

        {/* Send/Stop button - round grey style */}
        {isLoading && !text.trim() && attachments.length === 0 ? (
          // Stop button when loading and no content
          <button
            onClick={handleStop}
            disabled={disabled}
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
              "bg-destructive/10 hover:bg-destructive/20 text-destructive",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            title="Stop current query"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>
        ) : (
          // Send button (immediate send or queue)
          <button
            onClick={handleSend}
            disabled={disabled || isSending || (attachments.length === 0 && !text.trim())}
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
              isLoading
                ? "bg-primary/20 hover:bg-primary/30 text-primary"
                : "bg-muted hover:bg-muted/80",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            title={isLoading ? "Add to queue" : "Send message"}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        )}
      </div>

      <Dialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Queued Prompts</DialogTitle>
            <DialogDescription>
              Review pending prompts. Click a message to edit it, or reorder and remove items.
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
                          className="cursor-pointer rounded px-1 -mx-1 text-sm whitespace-pre-wrap break-words line-clamp-4 hover:bg-muted/50 transition-colors"
                          onClick={() => handleQueuedMessageClick(message)}
                          title="Click to edit this message"
                        >
                          {message.text}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>Effort: {EFFORT_LABELS[message.effort]}</span>
                          {message.planModeEnabled && <span>Plan mode</span>}
                          {message.fastModeEnabled && <span>Fast mode</span>}
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
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Move up"
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveQueuedMessage(index, index + 1)}
                          disabled={index === queuedMessages.length - 1}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Move down"
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveQueuedMessage(message.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                          title="Remove queued prompt"
                        >
                          <X className="w-4 h-4" />
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
