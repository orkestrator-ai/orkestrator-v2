import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  KeyboardEvent,
} from "react";
import {
  AlertCircle,
  X,
  FileText,
  ChevronDown,
  ArrowUp,
  Square,
  RefreshCw,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {cn, createSessionKey} from "@/lib/utils";
import { toast } from "sonner";
import { readContainerFileBase64, readFileBase64 } from "@/lib/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {useOpenCodeStore, type OpenCodeAttachment, type OpenCodeQueuedMessage} from "@/stores/openCodeStore";
import { ContextUsageWheel } from "@/components/chat/ContextUsageWheel";
import { persistAgentModelDefault } from "@/lib/chat/agent-model-preferences";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import {
  createWorkspaceAttachment,
  NativeAttachmentMenu,
} from "@/components/chat/NativeAttachmentMenu";
import { useFileMentions, useFileSearch, useMediaQuery, useNativeComposeBarPaste } from "@/hooks";
import { useSlashCommandMenu } from "@/hooks/useSlashCommandMenu";
import { useNativeComposeSubmit } from "@/hooks/useNativeComposeSubmit";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { usePromptQueueDispatchRecovery } from "@/hooks/usePromptQueueDispatchRecovery";
import {
  COMPOSE_MAX_INPUT_HEIGHT,
  COMPOSE_MIN_INPUT_HEIGHT,
} from "@/components/chat/compose-metrics";
import type {
  OpenCodeModel,
  OpenCodeConversationMode,
  OpenCodeSlashCommand,
} from "@/lib/opencode-client";
import type { FileCandidate, FileMention } from "@/types";
import {
  moveAgentPrompt,
  removeAgentPrompt,
  transferAgentPromptToComposeDraft,
} from "@/lib/prompt-queue-sources";
import { composerOccupiedError } from "@/lib/prompt-queue-errors";

interface OpenCodeComposeBarProps {
  environmentId: string;
  /** Tab ID for multi-tab attachment isolation */
  tabId: string;
  /** Container ID for containerized environments, undefined for local */
  containerId?: string;
  models: OpenCodeModel[];
  slashCommands?: OpenCodeSlashCommand[];
  favoriteModelIds?: string[];
  onSend: (text: string, attachments: OpenCodeAttachment[]) => void | Promise<void>;
  disabled?: boolean;
  /** Whether OpenCode is currently processing a query */
  isLoading?: boolean;
  /** Number of prompts waiting in queue */
  queueLength?: number;
  /** Callback when stop button is clicked */
  onStop?: () => void;
  /** Callback when prompt should be queued instead of sent */
  onQueue?: (text: string, attachments: OpenCodeAttachment[]) => void | Promise<void>;
  /** Callback to refresh/reload models */
  onRefreshModels?: () => void;
  /** Show the review follow-up action for review workflow tabs. */
  showAddressAll?: boolean;
  layout?: "bottom" | "centered";
}

const MAX_DATA_BACKED_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Stable empty array to avoid infinite re-render loops in useSyncExternalStore */
const EMPTY_QUEUE: OpenCodeQueuedMessage[] = [];

function attachmentMimeType(attachment: OpenCodeAttachment): string {
  const lastDot = attachment.name.lastIndexOf(".");
  const extension = lastDot > 0 && lastDot < attachment.name.length - 1
    ? attachment.name.slice(lastDot + 1).toLowerCase()
    : "";
  if (attachment.type === "image") {
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "gif") return "image/gif";
    if (extension === "webp") return "image/webp";
    return "image/png";
  }
  if (extension === "txt") return "text/plain";
  if (extension === "json") return "application/json";
  if (extension === "js" || extension === "mjs") return "text/javascript";
  if (extension === "ts" || extension === "tsx") return "text/typescript";
  if (extension === "md") return "text/markdown";
  if (extension === "html") return "text/html";
  if (extension === "css") return "text/css";
  if (extension === "py") return "text/x-python";
  if (extension === "rs") return "text/x-rust";
  return "application/octet-stream";
}

function base64DecodedByteLength(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function dataUrlByteLength(dataUrl: string | undefined): number {
  if (!dataUrl) return 0;
  const separatorIndex = dataUrl.indexOf(",");
  if (
    separatorIndex === -1
    || !dataUrl.slice(0, separatorIndex).toLowerCase().endsWith(";base64")
  ) {
    return 0;
  }
  return base64DecodedByteLength(dataUrl.slice(separatorIndex + 1));
}

export function OpenCodeComposeBar({
  environmentId,
  tabId,
  containerId,
  models,
  slashCommands = [],
  favoriteModelIds = [],
  onSend,
  disabled = false,
  isLoading = false,
  queueLength = 0,
  onStop,
  onQueue,
  onRefreshModels,
  showAddressAll = false,
  layout = "bottom",
}: OpenCodeComposeBarProps) {
  const [pendingAttachmentSnapshots, setPendingAttachmentSnapshots] = useState(0);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const prevFileMentionMenuOpen = useRef(false);
  const attachmentSelectionBlockedRef = useRef(disabled);
  const attachmentSelectionGenerationRef = useRef(0);
  const pendingAttachmentSnapshotsRef = useRef(0);
  const mountedRef = useRef(true);

  // Narrow store subscriptions (mirrors CodexComposeBar): actions are stable
  // references, and per-key value selectors keep unrelated store writes (other
  // sessions' drafts, transcripts, event bookkeeping) from re-rendering the bar.
  const addAttachment = useOpenCodeStore((state) => state.addAttachment);
  const removeAttachment = useOpenCodeStore((state) => state.removeAttachment);
  const setDraftText = useOpenCodeStore((state) => state.setDraftText);
  const setDraftMentions = useOpenCodeStore((state) => state.setDraftMentions);
  const setSelectedModel = useOpenCodeStore((state) => state.setSelectedModel);
  const setSelectedVariant = useOpenCodeStore((state) => state.setSelectedVariant);
  const setSelectedMode = useOpenCodeStore((state) => state.setSelectedMode);

  // Use session key so tab-scoped state (draft, attachments, mode) is isolated per tab
  const sessionKey = createSessionKey(environmentId, tabId);

  const contextUsage = useOpenCodeStore(
    useCallback((state) => state.contextUsage.get(sessionKey), [sessionKey])
  );

  const queuedMessages = useOpenCodeStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey) ?? EMPTY_QUEUE,
      [sessionKey]
    )
  );
  const queueRecovery = usePromptQueueDispatchRecovery("opencode", sessionKey);

  // Store getters return stable empties for absent keys, so their results are
  // safe as selector outputs (no per-render churn for untouched sessions).
  const attachments = useOpenCodeStore(
    useCallback((state) => state.getAttachments(sessionKey), [sessionKey]),
  );
  const text = useOpenCodeStore(
    useCallback((state) => state.getDraftText(sessionKey), [sessionKey]),
  );
  const mentions = useOpenCodeStore(
    useCallback((state) => state.getDraftMentions(sessionKey), [sessionKey]),
  );
  const selectedModel = useOpenCodeStore(
    useCallback((state) => state.getSelectedModel(sessionKey), [sessionKey]),
  );
  const selectedVariant = useOpenCodeStore(
    useCallback((state) => state.getSelectedVariant(sessionKey), [sessionKey]),
  );
  const selectedMode = useOpenCodeStore(
    useCallback((state) => state.getSelectedMode(sessionKey), [sessionKey]),
  );

  const [modelSearch, setModelSearch] = useState("");
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Sampled once so a later resize across the breakpoint cannot re-run the
  // mount focus effect and steal focus from whatever the user is doing.
  const autoFocusOnMountRef = useRef(!isMobile);

  // Get worktree path for local environments
  const worktreePath = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId)?.worktreePath
  );
  const fileSearch = useFileSearch(
    containerId,
    worktreePath
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

  // Focus input on mount, except on mobile where it would raise the on-screen
  // keyboard over the transcript before the user has asked to type.
  useEffect(() => {
    if (autoFocusOnMountRef.current) {
      inputRef.current?.focus();
    }
  }, []);

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

  const { isSending, submit: handleSend, submitPrompt } = useNativeComposeSubmit({
    agentLabel: "OpenCode",
    sessionKey,
    store: useOpenCodeStore,
    text,
    mentions,
    attachments,
    serializeForLLM,
    onSend,
    onQueue,
    isLoading,
    disabled,
    // Attachment bytes are still being read off disk; sending now would
    // dispatch a prompt referencing a snapshot that does not exist yet.
    canSubmit: () => pendingAttachmentSnapshotsRef.current === 0,
  });

  // Attachment selections started before the composer locked belong to a
  // previous generation and must be discarded when they resolve.
  const attachmentSelectionBlocked = disabled || isSending;
  if (attachmentSelectionBlocked && !attachmentSelectionBlockedRef.current) {
    attachmentSelectionGenerationRef.current += 1;
  }
  attachmentSelectionBlockedRef.current = attachmentSelectionBlocked;

  useEffect(() => {
    mountedRef.current = true;
    attachmentSelectionBlockedRef.current = attachmentSelectionBlocked;
    return () => {
      mountedRef.current = false;
      attachmentSelectionBlockedRef.current = true;
      attachmentSelectionGenerationRef.current += 1;
    };
    // Mount/unmount bookkeeping only — the value is refreshed above on every
    // render, so this must not re-run when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTextAndMentionsChange = useCallback(
    (newText: string, newMentions: FileMention[]) => {
      setDraftText(sessionKey, newText);
      setDraftMentions(sessionKey, newMentions);
    },
    [sessionKey, setDraftMentions, setDraftText]
  );

  const handleCursorPositionChange = useCallback(
    (position: number, currentText: string) => {
      detectFileMention(position, currentText);
    },
    [detectFileMention]
  );

  const handleFileMentionSelect = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      closeFileMentionMenu({ suppressReopenFor: file.filename });
      inputRef.current?.insertMention(mention);
    },
    [closeFileMentionMenu, createMention]
  );

  const handleWorkspaceFileSelect = useCallback(
    async (file: FileCandidate) => {
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
      pendingAttachmentSnapshotsRef.current += 1;
      setPendingAttachmentSnapshots((count) => count + 1);
      try {
        const selectionGeneration = attachmentSelectionGenerationRef.current;
        const base64 = containerId
          ? await readContainerFileBase64(containerId, file.relativePath)
          : await readFileBase64(attachment.path);
        if (
          attachmentSelectionBlockedRef.current
          || attachmentSelectionGenerationRef.current !== selectionGeneration
        ) {
          return;
        }
        const store = useOpenCodeStore.getState();
        const currentAttachmentBytes = store
          .getAttachments(sessionKey)
          .reduce(
            (total, currentAttachment) =>
              total + dataUrlByteLength(currentAttachment.previewUrl),
            0,
          );
        if (
          currentAttachmentBytes + base64DecodedByteLength(base64)
          > MAX_DATA_BACKED_ATTACHMENT_BYTES
        ) {
          toast.error("Cannot attach file", {
            description:
              "Attachments exceed the 20 MB total limit. Remove an attachment and try again.",
          });
          return;
        }
        store.addAttachment(sessionKey, {
          ...attachment,
          previewUrl: `data:${attachmentMimeType(attachment)};base64,${base64}`,
        });
      } catch (error) {
        console.error("[OpenCodeComposeBar] Failed to snapshot attachment:", error);
        toast.error("Cannot attach file", {
          description: error instanceof Error ? error.message : "Failed to read selected file",
        });
      } finally {
        pendingAttachmentSnapshotsRef.current = Math.max(
          0,
          pendingAttachmentSnapshotsRef.current - 1,
        );
        if (mountedRef.current) {
          setPendingAttachmentSnapshots((count) => Math.max(0, count - 1));
        }
      }
    },
    [addAttachment, containerId, disabled, isSending, sessionKey, worktreePath],
  );

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    onAttach: useCallback(
      (attachment) => addAttachment(sessionKey, attachment),
      [addAttachment, sessionKey],
    ),
    logLabel: "OpenCodeComposeBar",
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (fileMentionMenuOpen) {
      const handled = handleFileMentionKeyDown(event, handleFileMentionSelect);
      if (handled) return;
    }

    if (handleSlashKeyDown(event)) return;

    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      const nextMode: OpenCodeConversationMode = selectedMode === "plan" ? "build" : "plan";
      setSelectedMode(sessionKey, nextMode);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const handleAddressAll = () => submitPrompt(ADDRESS_ALL_REVIEW_PROMPT);

  const handleStop = () => {
    if (onStop) {
      onStop();
    }
  };

  const handleRemoveAttachment = (id: string) => {
    removeAttachment(sessionKey, id);
  };

  const handleRemoveQueuedMessage = async (messageId: string) => {
    await removeAgentPrompt("opencode", sessionKey, messageId);
  };

  const handleMoveQueuedMessage = async (fromIndex: number, toIndex: number) => {
    const message = queuedMessages[fromIndex];
    if (!message || Math.abs(toIndex - fromIndex) !== 1) return;
    await moveAgentPrompt(
      "opencode",
      sessionKey,
      message.id,
      toIndex < fromIndex ? "up" : "down",
    );
  };

  /**
   * Pull a queued prompt back into the composer for editing, restoring the
   * options it was queued with.
   */
  const handleQueuedMessageClick = useCallback(
    async (message: OpenCodeQueuedMessage) => {
      // Editing loads the prompt into the composer, so anything already there
      // would be destroyed. Refusing with a reason beats the silent overwrite
      // this used to do and beats the backend's opaque rejection downstream.
      if (text.trim().length > 0 || attachments.length > 0) {
        throw composerOccupiedError();
      }
      const removed = await transferAgentPromptToComposeDraft<OpenCodeQueuedMessage>(
        "opencode",
        sessionKey,
        message.id,
      );
      if (!removed) return;
      const store = useOpenCodeStore.getState();
      store.setDraftText(sessionKey, removed.text);
      store.setDraftMentions(sessionKey, []);
      store.clearAttachments(sessionKey);
      for (const attachment of removed.attachments) {
        store.addAttachment(sessionKey, attachment);
      }
      if (removed.model) {
        store.setSelectedModel(sessionKey, removed.model);
      }
      store.setSelectedVariant(sessionKey, removed.variant);
      store.setSelectedMode(sessionKey, removed.mode);
      setQueueDialogOpen(false);
      inputRef.current?.focus();
    },
    [attachments, sessionKey, text],
  );

  const handleModeChange = (mode: string) => {
    setSelectedMode(sessionKey, mode as OpenCodeConversationMode);
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(sessionKey, modelId);
    void persistAgentModelDefault("opencodeModel", modelId, "OpenCode");

    // Clear variant if the newly selected model doesn't support it
    const nextModel = models.find((m) => m.id === modelId);
    if (!nextModel?.variants || nextModel.variants.length === 0) {
      setSelectedVariant(sessionKey, undefined);
      return;
    }

    if (selectedVariant && !nextModel.variants.includes(selectedVariant)) {
      setSelectedVariant(sessionKey, undefined);
    }
  };

  const handleVariantChange = (variant: string | undefined) => {
    setSelectedVariant(sessionKey, variant);
  };

  // Get display name for selected model
  const selectedModelObj = models.find((m) => m.id === selectedModel);
  const selectedModelName = selectedModelObj?.name ?? "Select model";
  const availableVariants = useMemo(
    () => selectedModelObj?.variants ?? [],
    [selectedModelObj?.id, selectedModelObj?.variants]
  );
  const selectedVariantName = selectedVariant ?? "Default";

  // Group models by provider
  const modelsByProvider = models.reduce((acc, model) => {
    const provider = model.provider || "Other";
    if (!acc[provider]) {
      acc[provider] = [];
    }
    acc[provider].push(model);
    return acc;
  }, {} as Record<string, OpenCodeModel[]>);

  const favoriteModels = useMemo(() => {
    const byId = new Map(models.map((model) => [model.id, model]));
    const seen = new Set<string>();
    const favorites: OpenCodeModel[] = [];

    for (const id of favoriteModelIds) {
      if (seen.has(id)) continue;
      seen.add(id);

      const model = byId.get(id);
      if (model) {
        favorites.push(model);
      }
    }

    return favorites;
  }, [models, favoriteModelIds]);

  const modelNameById = useMemo(
    () => new Map(models.map((model) => [model.id, model.name])),
    [models]
  );

  // Filter models by search text - keeps provider grouping
  const filteredModelsByProvider = useMemo(() => {
    if (!modelSearch.trim()) return modelsByProvider;

    const search = modelSearch.toLowerCase();
    const filtered: Record<string, OpenCodeModel[]> = {};

    for (const [provider, providerModels] of Object.entries(modelsByProvider)) {
      const matches = providerModels.filter(
        (m) =>
          m.name.toLowerCase().includes(search) ||
          m.provider.toLowerCase().includes(search) ||
          m.id.toLowerCase().includes(search)
      );
      if (matches.length > 0) {
        filtered[provider] = matches;
      }
    }

    return filtered;
  }, [modelsByProvider, modelSearch]);

  // Sort filtered providers alphabetically
  const filteredProviders = Object.keys(filteredModelsByProvider).sort();

  // Check if search is active
  const isModelSearchActive = modelSearch.trim().length > 0;

  // Count total visible models
  const totalVisibleModels = useMemo(() => {
    let count = 0;
    for (const models of Object.values(filteredModelsByProvider)) {
      count += models.length;
    }
    return count;
  }, [filteredModelsByProvider]);

  // Capitalize mode for display
  const modeDisplayName = selectedMode === "plan" ? "Planning" : "Build";
  const sendDisabled =
    disabled ||
    isSending ||
    pendingAttachmentSnapshots > 0 ||
    (attachments.length === 0 && !text.trim());
  const showSendButton = !isLoading || !sendDisabled;

  return (
    <>
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

        {/* Text input area - on top */}
        <div className="relative" data-mentionable-input ref={inputContainerRef}>
          {slashMenuOpen && filteredSlashCommands.length > 0 && (
            <SlashCommandMenu
              commands={filteredSlashCommands}
              selectedIndex={slashSelectedIndex}
              onSelect={handleSlashCommandSelect}
              onClose={closeSlashMenu}
            />
          )}

          {fileMentionMenuOpen && (
            <FileMentionMenu
              files={filteredFiles}
              selectedIndex={fileMentionSelectedIndex}
              onSelect={handleFileMentionSelect}
              onClose={closeFileMentionMenu}
            />
          )}

          <MentionableInput
            ref={inputRef}
            value={text}
            mentions={mentions}
            onChange={handleTextAndMentionsChange}
            onCursorChange={handleCursorPositionChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything (⌘L), @ to mention, / for workflows"
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
              key={isSending || pendingAttachmentSnapshots > 0 ? "blocked" : "idle"}
              disabled={disabled || isSending || pendingAttachmentSnapshots > 0}
              fileSearch={fileSearch}
              onSelectFile={handleWorkspaceFileSelect}
              onCloseAutoFocus={() => inputRef.current?.focus()}
            />

          {/* Mode dropdown - minimal style */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                title={`${modeDisplayName} mode (Shift+Tab to cycle)`}
              >
                <ChevronDown className="w-3 h-3" />
                <span>{modeDisplayName}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => handleModeChange("plan")}>
                Planning
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleModeChange("build")}>
                Build
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Model dropdown - minimal style, grouped by provider */}
          <DropdownMenu onOpenChange={(open) => { if (!open) setModelSearch(""); }}>
            <DropdownMenuTrigger asChild>
              <button className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground sm:flex-none">
                <ChevronDown className="w-3 h-3" />
                <span className="min-w-0 max-w-full truncate sm:max-w-[200px]">{selectedModelName}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              collisionPadding={{ top: 52, right: 8, bottom: 8, left: 8 }}
              className="w-[calc(100vw-1rem)] sm:w-[320px]"
            >
              {/* Search input and refresh button */}
              <div className="p-2 pb-1">
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    placeholder="Search models..."
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") e.stopPropagation();
                    }}
                    className="flex-1 h-7 px-2 text-xs rounded border border-border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  {onRefreshModels && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRefreshModels();
                      }}
                      className="h-7 w-7 flex items-center justify-center rounded border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      title="Refresh models"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {models.length === 0 ? (
                <DropdownMenuItem disabled>No models available</DropdownMenuItem>
              ) : (
                <>
                  {favoriteModels.length > 0 && !isModelSearchActive && (
                    <>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="text-sm">
                          Favorites
                          <span className="ml-2 text-muted-foreground text-[10px]">
                            ({favoriteModels.length})
                          </span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuPortal>
                          <DropdownMenuSubContent className="max-h-[300px] overflow-y-auto">
                            {favoriteModels.map((model) => (
                              <DropdownMenuItem
                                key={model.id}
                                onClick={() => handleModelChange(model.id)}
                                className="text-sm"
                              >
                                <span className="truncate">{model.name}</span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuPortal>
                      </DropdownMenuSub>

                      <DropdownMenuSeparator />
                    </>
                  )}

                  {isModelSearchActive && (
                    <div className="px-2 py-1 text-[10px] text-muted-foreground">
                      {totalVisibleModels} model{totalVisibleModels !== 1 ? "s" : ""} found
                    </div>
                  )}

                  {filteredProviders.length === 0 ? (
                    <DropdownMenuItem disabled className="text-muted-foreground">No matches</DropdownMenuItem>
                  ) : (
                    filteredProviders.map((provider) => {
                      const providerModels = filteredModelsByProvider[provider] ?? [];
                      return (
                        <DropdownMenuSub key={provider}>
                          <DropdownMenuSubTrigger className="text-sm">
                            {provider}
                            <span className="ml-2 text-muted-foreground text-[10px]">
                              ({providerModels.length})
                            </span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuPortal>
                            <DropdownMenuSubContent className="max-h-[300px] overflow-y-auto">
                              {providerModels.map((model) => (
                                <DropdownMenuItem
                                  key={model.id}
                                  onClick={() => {
                                    handleModelChange(model.id);
                                    setModelSearch("");
                                  }}
                                  className="text-sm"
                                >
                                  <span className="truncate">{model.name}</span>
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuPortal>
                        </DropdownMenuSub>
                      );
                    })
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Variant dropdown - model-specific variants (e.g. low/high/xhigh) */}
          {availableVariants.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                  <ChevronDown className="w-3 h-3" />
                  <span className="max-w-[100px] truncate">{selectedVariantName}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => handleVariantChange(undefined)}>
                  {!selectedVariant && <span className="mr-1.5 text-foreground">&#10003;</span>}
                  Default
                </DropdownMenuItem>
                {availableVariants.map((variant) => (
                  <DropdownMenuItem key={variant} onClick={() => handleVariantChange(variant)}>
                    {selectedVariant === variant && <span className="mr-1.5 text-foreground">&#10003;</span>}
                    {variant}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          </div>

          <div
            data-native-compose-controls="secondary"
            className="flex w-full items-center gap-1 sm:ml-auto sm:w-auto"
          >

          <ContextUsageWheel usage={contextUsage} className="ml-1" />

          {/* Spacer */}
          <div className="flex-1 sm:hidden" />

          {/* Queue indicator. A parked queue stops draining until a human
              retries, so the failure has to be legible without opening the
              dialog. */}
          {queueLength > 0 && (
            <button
              type="button"
              onClick={() => setQueueDialogOpen(true)}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
                queueRecovery.dispatchError
                  ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                  : "text-muted-foreground bg-muted/50 hover:bg-muted",
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

          {/* Stop button stays available while loading */}
          {isLoading && (
            <button
              onClick={handleStop}
              disabled={disabled || !onStop}
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
                "bg-destructive/10 hover:bg-destructive/20 text-destructive",
                "disabled:opacity-50 disabled:cursor-not-allowed",
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

          {showSendButton && (
            <button
              onClick={handleSend}
              disabled={sendDisabled}
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
                isLoading
                  ? "bg-primary/20 hover:bg-primary/30 text-primary"
                  : "bg-muted hover:bg-muted/80",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
              title={isLoading ? "Add to queue" : "Send message"}
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          )}
          </div>
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
            <span>{message.mode === "plan" ? "Planning" : "Build"}</span>
            <span>
              {message.model
                ? modelNameById.get(message.model) || message.model
                : "Default model"}
            </span>
            {message.variant && <span>{message.variant}</span>}
            {message.attachments.length > 0 && (
              <span>
                {message.attachments.length} attachment
                {message.attachments.length === 1 ? "" : "s"}
              </span>
            )}
          </>
        )}
      />
    </>
  );
}
