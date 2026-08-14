import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  KeyboardEvent,
} from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createSessionKey } from "@/lib/utils";
import { toast } from "sonner";
import { readContainerFileBase64, readFileBase64 } from "@/lib/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {useOpenCodeStore, type OpenCodeAttachment, type OpenCodeQueuedMessage} from "@/stores/openCodeStore";
import { persistAgentModelDefault } from "@/lib/chat/agent-model-preferences";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeComposeBar } from "@/components/chat/NativeComposeBar";
import {
  createWorkspaceAttachment,
  NativeAttachmentMenu,
} from "@/components/chat/NativeAttachmentMenu";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import { useFileMentions, useFileSearch, useMediaQuery, useNativeComposeBarPaste } from "@/hooks";
import { useSlashCommandMenu } from "@/hooks/useSlashCommandMenu";
import { useNativeComposeSubmit } from "@/hooks/useNativeComposeSubmit";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { usePromptQueueDispatchRecovery } from "@/hooks/usePromptQueueDispatchRecovery";
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

export interface OpenCodeNativeComposerOptions {
  environmentId: string;
  /** Tab ID for multi-tab attachment isolation */
  tabId: string;
  /** Container ID for containerized environments, undefined for local */
  containerId?: string;
  models: OpenCodeModel[];
  slashCommands?: OpenCodeSlashCommand[];
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
const DEFAULT_VARIANT_ID = "__default__";

function formatVariantLabel(variant: string): string {
  if (variant === "xhigh") return "Extra high";
  return variant
    .replace(/[-_]+/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
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

/**
 * Whether the currently selected model can read image attachments.
 *
 * OpenCode's server rejects prompts that carry an image when the model has no
 * vision support (`Cannot read "..." (this model does not support image
 * input)`). The catalog reports `capabilities.input.image`; `undefined` means
 * it did not say, in which case the attach is allowed through.
 */
function imageSupportedBySelectedModel(
  attachment: { type: string },
  models: OpenCodeModel[],
  selectedModel: string | undefined,
): boolean {
  if (attachment.type !== "image") return true;
  if (!selectedModel || selectedModel === "default") return true;
  const model = models.find((candidate) => candidate.id === selectedModel);
  // An unknown catalog entry or a missing capability report lets the attach
  // through; only an explicit "no image input" blocks it.
  if (!model || model.supportsImageInput === undefined) return true;
  return model.supportsImageInput;
}

function showImageUnsupportedToast(): void {
  toast.error("Model cannot read images", {
    description:
      "The selected model does not support image input. Switch to a vision-capable model or remove the image.",
  });
}

export function useOpenCodeNativeComposer({
  environmentId,
  tabId,
  containerId,
  models,
  slashCommands = [],
  onSend,
  disabled = false,
  isLoading = false,
  queueLength = 0,
  onStop,
  onQueue,
  onRefreshModels,
  showAddressAll = false,
  layout = "bottom",
}: OpenCodeNativeComposerOptions) {
  const { favorites, enabledPlatforms, toggleFavorite } = useAgentModelFavorites();
  const [pendingAttachmentSnapshots, setPendingAttachmentSnapshots] = useState(0);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const prevFileMentionMenuOpen = useRef(false);
  const attachmentSelectionBlockedRef = useRef(disabled);
  const attachmentSelectionGenerationRef = useRef(0);
  const pendingAttachmentSnapshotsRef = useRef(0);
  const mountedRef = useRef(true);

  // Narrow store subscriptions: actions are stable
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
      if (!imageSupportedBySelectedModel(attachment, models, selectedModel)) {
        showImageUnsupportedToast();
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
        console.error("[useOpenCodeNativeComposer] Failed to snapshot attachment:", error);
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
    [addAttachment, containerId, disabled, isSending, models, selectedModel, sessionKey, worktreePath],
  );

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    // The gate runs in the hook before the pasted image is written to disk, so
    // a refused image cannot orphan a file in the environment. `onAttach` is
    // then free to add unconditionally.
    //
    // The model is read from the store rather than the render closure: the gate
    // fires after an async decode, so a model switch during that window would
    // otherwise be invisible to it. Depending only on `sessionKey` also stops
    // the document paste listener re-registering on every model change.
    canAttachImage: useCallback(
      (attachment: { type: string }) =>
        imageSupportedBySelectedModel(
          attachment,
          models,
          useOpenCodeStore.getState().getSelectedModel(sessionKey),
        ),
      [models, sessionKey],
    ),
    onImageRejected: showImageUnsupportedToast,
    onAttach: useCallback(
      (attachment) => addAttachment(sessionKey, attachment),
      [addAttachment, sessionKey],
    ),
    logLabel: "useOpenCodeNativeComposer",
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

    // The attach-time gate cannot see a later model switch, so an image
    // attached under a vision model would otherwise sit in the composer until
    // the server rejected the send. Warn while the user can still act on it.
    if (
      attachments.some((attachment) => attachment.type === "image")
      && !imageSupportedBySelectedModel({ type: "image" }, models, modelId)
    ) {
      showImageUnsupportedToast();
    }

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
  const selectedVariantName = selectedVariant ? formatVariantLabel(selectedVariant) : "Default";

  const modelNameById = useMemo(
    () => new Map(models.map((model) => [model.id, model.name])),
    [models]
  );

  // Capitalize mode for display
  const modeDisplayName = selectedMode === "plan" ? "Planning" : "Build";
  const sendDisabled =
    disabled ||
    isSending ||
    pendingAttachmentSnapshots > 0 ||
    (attachments.length === 0 && !text.trim());
  const showSendButton = !isLoading || !sendDisabled;

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
      placeholder="Ask anything (⌘L), @ to mention, / for workflows"
      disabled={disabled || pendingAttachmentSnapshots > 0}
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
            key={isSending || pendingAttachmentSnapshots > 0 ? "blocked" : "idle"}
            disabled={disabled || isSending || pendingAttachmentSnapshots > 0}
            fileSearch={fileSearch}
            onSelectFile={handleWorkspaceFileSelect}
            onCloseAutoFocus={() => inputRef.current?.focus()}
          />
          <AgentModelPicker
            favorites={favorites}
            enabledPlatforms={enabledPlatforms}
            selectedPlatform="opencode"
            platformSelectionLocked
            onToggleFavorite={toggleFavorite}
            models={models.map((model) => ({
              id: model.id,
              platform: "opencode",
              label: model.name,
              providerLabel: model.provider ? `OpenCode/${model.provider}` : "Other",
              description: model.provider || "Other",
            }))}
            selectedModelId={selectedModel}
            selectedModelLabel={selectedModelName}
            onModelChange={handleModelChange}
            reasoningOptions={availableVariants.length > 0
              ? [
                  { id: DEFAULT_VARIANT_ID, label: "Default" },
                  ...availableVariants.map((variant) => ({
                    id: variant,
                    label: formatVariantLabel(variant),
                  })),
                ]
              : []}
            selectedReasoningId={availableVariants.length > 0
              ? selectedVariant ?? DEFAULT_VARIANT_ID
              : undefined}
            selectedReasoningLabel={availableVariants.length > 0
              ? selectedVariantName
              : undefined}
            onReasoningChange={availableVariants.length > 0
              ? (variant) => {
                  handleVariantChange(variant === DEFAULT_VARIANT_ID ? undefined : variant);
                }
              : undefined}
            fastModeAvailable={false}
            disabled={disabled}
            onRefreshModels={onRefreshModels}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                title={`${modeDisplayName} mode (Shift+Tab to cycle)`}
              >
                <ChevronDown className="h-3 w-3" />
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
      onSend={handleSend}
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
              <span>{message.mode === "plan" ? "Planning" : "Build"}</span>
              <span>
                {message.model
                  ? modelNameById.get(message.model) || message.model
                  : "Default model"}
              </span>
              {message.variant ? <span>{message.variant}</span> : null}
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
