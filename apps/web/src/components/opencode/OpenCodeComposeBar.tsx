import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  KeyboardEvent,
} from "react";
import {
  X,
  FileText,
  ChevronDown,
  ChevronUp,
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
import { readContainerFileBase64, readFileBase64 } from "@/lib/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useOpenCodeStore, createOpenCodeSessionKey, type OpenCodeAttachment, type OpenCodeQueuedMessage } from "@/stores/openCodeStore";
import { ContextUsageWheel } from "@/components/chat/ContextUsageWheel";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import {
  createWorkspaceAttachment,
  NativeAttachmentMenu,
} from "@/components/chat/NativeAttachmentMenu";
import { useFileMentions, useFileSearch, useMediaQuery, useNativeComposeBarPaste } from "@/hooks";
import { OpenCodeSlashCommandMenu } from "./OpenCodeSlashCommandMenu";
import type {
  OpenCodeModel,
  OpenCodeConversationMode,
  OpenCodeSlashCommand,
} from "@/lib/opencode-client";
import type { FileCandidate, FileMention } from "@/types";

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

const MAX_LINES = 12;
const LINE_HEIGHT = 20;
const MIN_INPUT_HEIGHT = LINE_HEIGHT + 8;
const MAX_INPUT_HEIGHT = MAX_LINES * LINE_HEIGHT + 16;
const MAX_DATA_BACKED_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Stable empty array to avoid infinite re-render loops in useSyncExternalStore */
const EMPTY_QUEUE: OpenCodeQueuedMessage[] = [];

function fileMentionsEqual(
  left: readonly FileMention[],
  right: readonly FileMention[],
): boolean {
  return left.length === right.length && left.every((mention, index) => {
    const other = right[index];
    return other !== undefined
      && mention.id === other.id
      && mention.filename === other.filename
      && mention.relativePath === other.relativePath;
  });
}

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
  const [isSending, setIsSending] = useState(false);
  const [pendingAttachmentSnapshots, setPendingAttachmentSnapshots] = useState(0);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const prevFileMentionMenuOpen = useRef(false);
  const attachmentSelectionBlockedRef = useRef(disabled || isSending);
  const attachmentSelectionGenerationRef = useRef(0);
  const pendingAttachmentSnapshotsRef = useRef(0);
  const mountedRef = useRef(true);
  const attachmentSelectionBlocked = disabled || isSending;
  if (attachmentSelectionBlocked && !attachmentSelectionBlockedRef.current) {
    attachmentSelectionGenerationRef.current += 1;
  }
  attachmentSelectionBlockedRef.current = attachmentSelectionBlocked;

  useEffect(() => {
    mountedRef.current = true;
    attachmentSelectionBlockedRef.current = disabled || isSending;
    return () => {
      mountedRef.current = false;
      attachmentSelectionBlockedRef.current = true;
      attachmentSelectionGenerationRef.current += 1;
    };
  }, []);

  const {
    getAttachments,
    addAttachment,
    removeAttachment,
    getDraftText,
    setDraftText,
    getDraftMentions,
    setDraftMentions,
    getSelectedModel,
    setSelectedModel,
    getSelectedVariant,
    setSelectedVariant,
    getSelectedMode,
    setSelectedMode,
    removeQueueItem,
    moveQueueItem,
  } = useOpenCodeStore();

  // Use session key so tab-scoped state (draft, attachments, mode) is isolated per tab
  const sessionKey = createOpenCodeSessionKey(environmentId, tabId);

  const contextUsage = useOpenCodeStore(
    useCallback((state) => state.contextUsage.get(sessionKey), [sessionKey])
  );

  const queuedMessages = useOpenCodeStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey) ?? EMPTY_QUEUE,
      [sessionKey]
    )
  );

  const attachments = getAttachments(sessionKey);
  const text = getDraftText(sessionKey);
  const mentions = getDraftMentions(sessionKey);
  const selectedModel = getSelectedModel(environmentId);
  const selectedVariant = getSelectedVariant(environmentId);
  const selectedMode = getSelectedMode(sessionKey);

  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashFilter, setSlashFilter] = useState("");
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
  }, [text, slashCommands.length]);

  const filteredSlashCommands = useMemo(
    () =>
      slashCommands.filter((command) =>
        command.name.toLowerCase().includes(slashFilter.toLowerCase()),
      ),
    [slashCommands, slashFilter],
  );

  const handleSlashCommandSelect = useCallback(
    (command: OpenCodeSlashCommand) => {
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

    if (slashMenuOpen && filteredSlashCommands.length > 0) {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSlashSelectedIndex((prev) =>
            prev < filteredSlashCommands.length - 1 ? prev + 1 : prev,
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

    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      const nextMode: OpenCodeConversationMode = selectedMode === "plan" ? "build" : "plan";
      setSelectedMode(sessionKey, nextMode);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    if (isSending || disabled || pendingAttachmentSnapshotsRef.current > 0) return;
    if (attachments.length === 0 && !text.trim()) return;

    const submittedText = text;
    const submittedMentions = mentions;
    const submittedAttachments = attachments;
    setIsSending(true);
    const isQueueing = isLoading && Boolean(onQueue);
    try {
      const serializedText = serializeForLLM(text.trim(), mentions);
      if (isQueueing) {
        await onQueue!(serializedText, attachments);
      } else {
        await onSend(serializedText, attachments);
      }
      const store = useOpenCodeStore.getState();
      if (
        store.getDraftText(sessionKey) === submittedText
        && fileMentionsEqual(
          store.getDraftMentions(sessionKey),
          submittedMentions,
        )
      ) {
        store.setDraftText(sessionKey, "");
        store.setDraftMentions(sessionKey, []);
      }
      for (const attachment of submittedAttachments) {
        store.removeAttachment(sessionKey, attachment.id);
      }
    } catch (error) {
      console.error(
        `[OpenCodeComposeBar] Failed to ${isQueueing ? "queue" : "send"} prompt:`,
        error,
      );
      toast.error(isQueueing ? "Failed to queue prompt" : "Failed to send prompt");
    } finally {
      setIsSending(false);
    }
  };

  const handleAddressAll = async () => {
    if (isSending || disabled || isLoading) return;

    setIsSending(true);
    try {
      await onSend(ADDRESS_ALL_REVIEW_PROMPT, []);
    } catch (error) {
      console.error("[OpenCodeComposeBar] Failed to send review follow-up:", error);
      toast.error("Failed to send prompt");
    } finally {
      setIsSending(false);
    }
  };

  const handleStop = () => {
    if (onStop) {
      onStop();
    }
  };

  const handleRemoveAttachment = (id: string) => {
    removeAttachment(sessionKey, id);
  };

  const handleRemoveQueuedMessage = (messageId: string) => {
    removeQueueItem(sessionKey, messageId);
  };

  const handleMoveQueuedMessage = (fromIndex: number, toIndex: number) => {
    moveQueueItem(sessionKey, fromIndex, toIndex);
  };

  const handleModeChange = (mode: string) => {
    setSelectedMode(sessionKey, mode as OpenCodeConversationMode);
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(environmentId, modelId);

    // Clear variant if the newly selected model doesn't support it
    const nextModel = models.find((m) => m.id === modelId);
    if (!nextModel?.variants || nextModel.variants.length === 0) {
      setSelectedVariant(environmentId, undefined);
      return;
    }

    if (selectedVariant && !nextModel.variants.includes(selectedVariant)) {
      setSelectedVariant(environmentId, undefined);
    }
  };

  const handleVariantChange = (variant: string | undefined) => {
    setSelectedVariant(environmentId, variant);
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
            <OpenCodeSlashCommandMenu
              commands={filteredSlashCommands}
              selectedIndex={slashSelectedIndex}
              onSelect={handleSlashCommandSelect}
              onClose={() => setSlashMenuOpen(false)}
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
            minHeight={MIN_INPUT_HEIGHT}
            maxHeight={MAX_INPUT_HEIGHT}
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

      <Dialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Queued Prompts</DialogTitle>
            <DialogDescription>
              Review pending prompts, remove items, or reorder what sends next.
            </DialogDescription>
          </DialogHeader>

          {queuedMessages.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Queue is empty.
            </div>
          ) : (
            <ScrollArea className="max-h-[380px] pr-3">
              <div className="space-y-2">
                {queuedMessages.map((message, index) => {
                  const modelLabel = message.model
                    ? modelNameById.get(message.model) || message.model
                    : "Default model";
                  const modeLabel = message.mode === "plan" ? "Planning" : "Build";
                  const attachmentCount = message.attachments.length;

                  return (
                    <div
                      key={message.id}
                      className="rounded-md border border-border bg-muted/20 p-3"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground">
                          #{index + 1}
                        </div>

                        <div className="min-w-0 flex-1">
                          <p className="text-sm whitespace-pre-wrap break-words line-clamp-4">
                            {message.text}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>{modeLabel}</span>
                            <span>{modelLabel}</span>
                            {message.variant && <span>{message.variant}</span>}
                            {attachmentCount > 0 && (
                              <span>
                                {attachmentCount} attachment
                                {attachmentCount === 1 ? "" : "s"}
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
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
