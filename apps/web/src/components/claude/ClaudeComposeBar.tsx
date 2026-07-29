import { useRef, useEffect, useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { X, FileText, ChevronDown, ArrowUp, Check, Square, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {cn, createSessionKey} from "@/lib/utils";
import { toast } from "sonner";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {useClaudeStore, type ClaudeAttachment, type QueuedMessage, type ClaudeEffortLevel} from "@/stores/claudeStore";
import { ContextUsageWheel } from "@/components/chat/ContextUsageWheel";
import { persistAgentModelDefault } from "@/lib/chat/agent-model-preferences";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import type { ClaudeModel } from "@/lib/claude-client";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import { parseSlashCommands } from "@/lib/chat/slash-commands";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { usePromptQueueDispatchRecovery } from "@/hooks/usePromptQueueDispatchRecovery";
import {
  COMPOSE_MAX_INPUT_HEIGHT,
  COMPOSE_MIN_INPUT_HEIGHT,
} from "@/components/chat/compose-metrics";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import {
  createWorkspaceAttachment,
  NativeAttachmentMenu,
} from "@/components/chat/NativeAttachmentMenu";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useFileMentions } from "@/hooks/useFileMentions";
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import { useSlashCommandMenu } from "@/hooks/useSlashCommandMenu";
import { useNativeComposeSubmit } from "@/hooks/useNativeComposeSubmit";
import { useMediaQuery } from "@/hooks/useMediaQuery";
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
  onPlanModeChange,
  showAddressAll = false,
  layout = "bottom",
}: ClaudeComposeBarProps) {
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Sampled once so a later resize across the breakpoint cannot re-run the
  // mount focus effect and steal focus from whatever the user is doing.
  const autoFocusOnMountRef = useRef(!isMobile);

  // Create sessionKey for store lookups (format: "env-{environmentId}:{tabId}")
  const sessionKey = createSessionKey(environmentId, tabId);

  // Narrow store subscriptions (mirrors CodexComposeBar): actions are stable
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
  const removeQueueItem = useClaudeStore((state) => state.removeQueueItem);
  const moveQueueItem = useClaudeStore((state) => state.moveQueueItem);

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
    logLabel: "ClaudeComposeBar",
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
      applyPlanMode(message.planModeEnabled);
      setFastMode(sessionKey, message.fastModeEnabled);
      setQueueDialogOpen(false);
      inputRef.current?.focus();
    },
    [removeQueueItem, sessionKey, clearAttachments, addAttachment, setDraftText, setDraftMentions, setEffort, applyPlanMode, setFastMode]
  );

  const handleRemoveAttachment = (id: string) => {
    removeAttachment(sessionKey, id);
  };

  // Get display name for selected model - default to first model if none selected
  const effectiveSelectedModel = selectedModel ?? models[0]?.id;
  const selectedModelObj = models.find((m) => m.id === effectiveSelectedModel);
  const selectedModelName = selectedModelObj?.name ?? (models.length > 0 ? models[0]?.name : "No models");
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
                disabled={disabled || isSending}
                className="ml-1 p-0.5 rounded-full hover:bg-muted"
                aria-label={`Remove ${att.name}`}
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
            onClose={closeSlashMenu}
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
          minHeight={COMPOSE_MIN_INPUT_HEIGHT}
          maxHeight={COMPOSE_MAX_INPUT_HEIGHT}
        />
      </div>

      {/* Bottom toolbar */}
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
          />

        {/* Model dropdown - minimal style */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground sm:flex-none">
              <ChevronDown className="w-3 h-3" />
              <span className="min-w-0 max-w-full truncate sm:max-w-[200px]">{selectedModelName}</span>
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
            <DropdownMenuItem onClick={() => applyPlanMode(false)}>
              <div className="w-4 h-4 shrink-0 mr-2">
                {!planModeEnabled && <Check className="w-4 h-4 text-primary" />}
              </div>
              Build
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => applyPlanMode(true)}>
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

        </div>

        <div
          data-native-compose-controls="secondary"
          className="flex w-full items-center gap-1 sm:ml-auto sm:w-auto"
        >

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
        <div className="flex-1 sm:hidden" />

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

        {/* Stop button stays available while loading */}
        {isLoading && (
          <button
            onClick={handleStop}
            disabled={disabled || !onStop}
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
              "bg-destructive/10 hover:bg-destructive/20 text-destructive",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            title="Stop current query"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>
        )}

        {showAddressAll && !isLoading && (
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
        )}

        {/* Send button (immediate send or queue) */}
        {showSendButton && (
          <button
            onClick={() => void submit()}
            disabled={sendDisabled}
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
            <span>Effort: {EFFORT_LABELS[message.effort]}</span>
            {message.planModeEnabled && <span>Plan mode</span>}
            {message.fastModeEnabled && <span>Fast mode</span>}
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
