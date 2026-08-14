import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, History } from "lucide-react";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { Button } from "@/components/ui/button";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeAttachmentMenu } from "@/components/chat/NativeAttachmentMenu";
import { NativeComposeBar } from "@/components/chat/NativeComposeBar";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import {
  ClaudeIcon,
  CodexIcon,
  CursorAgentIcon,
  GrokBuildIcon,
  OpenCodeIcon,
} from "@/components/icons/AgentIcons";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import { useFileMentions } from "@/hooks/useFileMentions";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import { getNativeAgentModelCatalog } from "@/lib/backend";
import { buildInitialPromptWithAttachmentReferences } from "@/lib/initial-prompt-attachments";
import { createPersistedPaneLayoutInput, flushPaneLayoutNow } from "@/lib/pane-layout-persistence";
import { createSessionKey } from "@/lib/utils";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { FileCandidate, FileMention } from "@/types";
import { toast } from "sonner";
import {
  findNativeAgentAdapter,
  nativeAgentAdapters,
  type NativeAgentAdapter,
  type AgentNativeTabProps,
} from "./adapter";

const controllerCache = new Map<
  NonNullable<AgentNativeTabProps["data"]["platform"]>,
  ReturnType<typeof lazy>
>();

function controllerFor(adapter: NativeAgentAdapter) {
  const cached = controllerCache.get(adapter.platform);
  if (cached) return cached;
  const Controller = lazy(async () => ({
    default: await adapter.loadController(),
  }));
  controllerCache.set(adapter.platform, Controller);
  return Controller;
}

function PlatformIcon({ platform }: { platform: AgentPlatform }) {
  const className = "size-5";
  if (platform === "claude") return <ClaudeIcon className={className} />;
  if (platform === "codex") return <CodexIcon className={className} />;
  if (platform === "opencode") return <OpenCodeIcon className={className} />;
  if (platform === "cursor") return <CursorAgentIcon className={className} />;
  return <GrokBuildIcon className={className} />;
}

function NativeAgentResumePlatformDialog({
  open,
  onOpenChange,
  enabledPlatforms,
  disabled,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabledPlatforms: AgentPlatform[];
  disabled: boolean;
  onSelect: (platform: AgentPlatform) => void;
}) {
  const platforms = AGENT_PLATFORMS.filter((platform) => enabledPlatforms.includes(platform));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resume a session</DialogTitle>
          <DialogDescription>
            Choose which agent the session belongs to. You’ll choose the session next.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {platforms.map((platform) => {
            const adapter = nativeAgentAdapters[platform];
            const canResume = adapter.capabilities.resume;
            return (
              <button
                key={platform}
                type="button"
                disabled={disabled || !canResume}
                onClick={() => onSelect(platform)}
                className="flex items-center gap-3 rounded-lg border border-border/70 bg-zinc-900/60 px-3 py-3 text-left transition-colors hover:border-border hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/50">
                  <PlatformIcon platform={platform} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{adapter.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {canResume ? "Choose a previous session" : "Session resume is not available yet"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UnassignedNativeAgentComposer({
  tabId,
  environmentId,
  containerId,
  disabled,
  onSend,
  onResume,
}: {
  tabId: string;
  environmentId: string;
  containerId?: string;
  disabled: boolean;
  onSend: (
    platform: AgentPlatform,
    prompt: string,
    options: {
      modelId?: string;
      reasoningId?: string;
      fastMode: boolean;
      mode: "build" | "plan";
    },
  ) => void;
  onResume: (platform: AgentPlatform) => void;
}) {
  const sessionKey = createSessionKey(environmentId, tabId);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const draft = useNativeComposeStore((state) => nativeComposeDraft(state, sessionKey));
  const updateDraft = useNativeComposeStore((state) => state.updateDraft);
  const defaultPlatform = useConfigStore((state) => state.config.global.defaultAgent ?? "claude");
  const environment = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId),
  );
  const worktreePath = environment?.worktreePath;
  const { favorites, enabledPlatforms, toggleFavorite } = useAgentModelFavorites();
  const [resumePlatformDialogOpen, setResumePlatformDialogOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    void getNativeAgentModelCatalog(environmentId)
      .then((catalog) => {
        if (!cancelled) setModels(catalog);
      })
      .catch((error) => {
        console.warn("[AgentNativeTab] Failed to load native model catalogue:", error);
      });
    return () => { cancelled = true; };
  }, [environmentId]);
  const platform = draft.platform ?? defaultPlatform;
  const selectedAdapter = findNativeAgentAdapter(platform);
  const fileSearch = useFileSearch(containerId, worktreePath);
  const {
    isMenuOpen: fileMentionMenuOpen,
    selectedIndex: fileMentionSelectedIndex,
    filteredFiles,
    handleCursorChange: detectFileMention,
    handleKeyDown: handleFileMentionKeyDown,
    closeMenu: closeFileMentionMenu,
    serializeForLLM,
    createMention,
  } = useFileMentions({ searchFiles: fileSearch.searchFiles });
  const platformModels = models.filter((model) => model.platform === platform);
  const selectedModel = models.find((model) => model.id === draft.modelId && model.platform === platform)
    ?? platformModels[0];
  const canConfigureModel = platform !== "cursor" && platform !== "grok";
  const selectedReasoningId = draft.reasoningId ?? selectedModel?.defaultReasoningId;
  const selectedReasoningLabel = selectedModel?.reasoning?.find(
    (option) => option.id === selectedReasoningId,
  )?.label ?? "Default";
  const handleTextAndMentionsChange = useCallback(
    (text: string, mentions: FileMention[]) => updateDraft(sessionKey, { text, mentions }),
    [sessionKey, updateDraft],
  );
  const handleFileMentionSelect = useCallback((file: FileCandidate) => {
    const mention = createMention(file);
    closeFileMentionMenu({ suppressReopenFor: file.filename });
    inputRef.current?.insertMention(mention);
  }, [closeFileMentionMenu, createMention]);
  const handleWorkspaceFileSelect = useCallback((file: FileCandidate) => {
    const mention = createMention(file);
    closeFileMentionMenu({ suppressReopenFor: file.filename });
    inputRef.current?.insertMentionAtCursor(mention);
  }, [closeFileMentionMenu, createMention]);
  const handlePastedImage = useCallback((attachment: {
    id: string;
    type: "image";
    path: string;
    previewUrl: string;
    name: string;
  }) => {
    const current = useNativeComposeStore.getState().drafts.get(sessionKey);
    updateDraft(sessionKey, {
      attachments: [...(current?.attachments ?? []), attachment],
    });
  }, [sessionKey, updateDraft]);
  const canAttachImage = useCallback(
    () => selectedAdapter?.capabilities.attachments.images === true,
    [selectedAdapter],
  );
  const handleImageRejected = useCallback(
    () => toast.error("Images are not supported by this agent"),
    [],
  );

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    onAttach: handlePastedImage,
    canAttachImage,
    onImageRejected: handleImageRejected,
    logLabel: "UnassignedNativeAgentComposer",
  });

  const send = () => {
    const prompt = buildInitialPromptWithAttachmentReferences(
      serializeForLLM(draft.text, draft.mentions),
      draft.attachments.map(({ name, path }) => ({ name, path })),
    );
    if (!prompt || disabled) return;
    onSend(platform, prompt, {
      modelId: selectedModel?.id,
      reasoningId: selectedReasoningId,
      fastMode: draft.fastMode,
      mode: draft.mode,
    });
  };

  return (
    <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <NativeComposeDock
        centered
        actions={(
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setResumePlatformDialogOpen(true)}
            disabled={disabled}
            className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
          >
            <History className="mr-2 h-4 w-4" />
            Resume Session
          </Button>
        )}
      >
        <NativeComposeBar
          testId="unassigned-native-compose-bar"
          layout="centered"
          attachments={draft.attachments}
          onRemoveAttachment={(attachmentId) => updateDraft(sessionKey, {
            attachments: draft.attachments.filter((candidate) => candidate.id !== attachmentId),
          })}
          inputRef={inputRef}
          inputContainerRef={inputContainerRef}
          text={draft.text}
          mentions={draft.mentions}
          onTextAndMentionsChange={handleTextAndMentionsChange}
          onCursorPositionChange={detectFileMention}
          onKeyDown={(event) => {
            if (fileMentionMenuOpen && handleFileMentionKeyDown(event, handleFileMentionSelect)) {
              return;
            }
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
          placeholder="Ask an agent anything…"
          disabled={disabled}
          menus={fileMentionMenuOpen ? (
              <FileMentionMenu
                files={filteredFiles}
                selectedIndex={fileMentionSelectedIndex}
                onSelect={handleFileMentionSelect}
                onClose={closeFileMentionMenu}
              />
            ) : null}
          primaryControls={(
            <>
              <NativeAttachmentMenu
                disabled={disabled}
                fileSearch={fileSearch}
                onSelectFile={handleWorkspaceFileSelect}
                onCloseAutoFocus={() => inputRef.current?.focus()}
                fileActionLabel="Mention file from workspace"
                filePickerTitle="Mention workspace file"
                filePickerDescription="Search this environment and mention a file in the first prompt."
              />
              <AgentModelPicker
                models={models}
                favorites={favorites}
                enabledPlatforms={enabledPlatforms}
                selectedPlatform={platform}
                onPlatformChange={(next) => updateDraft(sessionKey, { platform: next, modelId: undefined, reasoningId: undefined })}
                onToggleFavorite={toggleFavorite}
                selectedModelId={selectedModel?.id}
                selectedModelLabel={selectedModel?.label ?? (canConfigureModel ? "No models available" : "Automatic")}
                onModelChange={(modelId) => {
                  // Platform selection is applied synchronously by the picker
                  // before model selection. Read it back from the neutral draft so
                  // identical provider-local model ids cannot route to the first
                  // matching catalog entry from another provider.
                  const selectedPlatform = useNativeComposeStore.getState().drafts
                    .get(sessionKey)?.platform ?? platform;
                  const model = models.find((candidate) =>
                    candidate.platform === selectedPlatform && candidate.id === modelId,
                  );
                  updateDraft(sessionKey, {
                    modelId,
                    platform: selectedPlatform,
                    reasoningId: model?.defaultReasoningId,
                  });
                }}
                reasoningOptions={selectedModel?.reasoning ?? []}
                selectedReasoningId={selectedReasoningId}
                selectedReasoningLabel={selectedReasoningLabel}
                onReasoningChange={canConfigureModel ? (reasoningId) => updateDraft(sessionKey, { reasoningId }) : undefined}
                fastModeEnabled={draft.fastMode}
                fastModeAvailable={selectedModel?.supportsSpeed === true}
                onFastModeChange={(fastMode) => updateDraft(sessionKey, { fastMode })}
                disabled={disabled}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || !canConfigureModel}
                    aria-label="Conversation mode"
                    className="h-8 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                  >
                    {draft.mode === "plan" ? "Plan" : "Build"}
                    <ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup
                    value={draft.mode}
                    onValueChange={(mode) => updateDraft(sessionKey, { mode: mode as "build" | "plan" })}
                  >
                    <DropdownMenuRadioItem value="build">Build</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="plan">Plan</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          sendDisabled={disabled || (!draft.text.trim() && draft.attachments.length === 0)}
          sendTitle="Start agent"
          onSend={send}
        />
      </NativeComposeDock>
      <NativeAgentResumePlatformDialog
        open={resumePlatformDialogOpen}
        onOpenChange={setResumePlatformDialogOpen}
        enabledPlatforms={enabledPlatforms}
        disabled={disabled}
        onSelect={(selectedPlatform) => {
          setResumePlatformDialogOpen(false);
          onResume(selectedPlatform);
        }}
      />
    </div>
  );
}

/**
 * The only pane-level native agent tab. Provider controllers are selected by
 * the adapter registry and remain below this stable presentation boundary.
 */
export const AgentNativeTab = memo(function AgentNativeTab(
  props: AgentNativeTabProps,
) {
  const [awaitingDurability, setAwaitingDurability] = useState(false);
  const [durabilityError, setDurabilityError] = useState<string | null>(null);
  const [pendingDurabilityOperation, setPendingDurabilityOperation] = useState<
    "send" | "resume" | null
  >(null);
  const [resumeRequestedPlatform, setResumeRequestedPlatform] = useState<AgentPlatform | null>(null);
  const adapter = useMemo(
    () => props.data.platform
      ? findNativeAgentAdapter(props.data.platform)
      : undefined,
    [props.data.platform],
  );
  const Controller = useMemo(
    () => (adapter ? controllerFor(adapter) : null),
    [adapter],
  );
  const persistLockedPane = useCallback(async (operation: "send" | "resume") => {
    setAwaitingDurability(true);
    setDurabilityError(null);
    setPendingDurabilityOperation(operation);
    const environment = usePaneLayoutStore.getState().environments.get(props.data.environmentId);
    if (!environment) {
      setDurabilityError("The locked agent tab is no longer available to save.");
      setAwaitingDurability(false);
      return;
    }
    try {
      await flushPaneLayoutNow(
        props.data.environmentId,
        createPersistedPaneLayoutInput(environment),
      );
      if (operation === "send") {
        useNativeComposeStore.getState().clearDraft(
          createSessionKey(props.data.environmentId, props.tabId),
        );
      }
      setPendingDurabilityOperation(null);
      setAwaitingDurability(false);
    } catch (error) {
      console.warn("[AgentNativeTab] Failed to persist provider lock:", error);
      setDurabilityError("The agent choice is locked, but could not be saved.");
      setAwaitingDurability(false);
    }
  }, [props.data.environmentId, props.tabId]);
  const lockAndSend = useCallback(async (
    platform: AgentPlatform,
    prompt: string,
    options: { modelId?: string; reasoningId?: string; fastMode: boolean; mode: "build" | "plan" },
  ) => {
    setAwaitingDurability(true);
    setDurabilityError(null);
    const paneStore = usePaneLayoutStore.getState();
    const lockedPlatform = paneStore.lockTabNativePlatform(
      props.tabId,
      platform,
      props.data.environmentId,
      {
        initialPrompt: prompt,
        initialAgentModel: options.modelId,
        initialReasoningEffort: options.reasoningId,
      },
    );
    if (!lockedPlatform) {
      setDurabilityError("This tab could not be locked to an agent.");
      setPendingDurabilityOperation(null);
      setAwaitingDurability(false);
      return;
    }
    const sessionKey = createSessionKey(props.data.environmentId, props.tabId);
    if (lockedPlatform === platform) {
      if (platform === "claude") {
        const store = useClaudeStore.getState();
        if (options.modelId) store.setSelectedModel(sessionKey, options.modelId);
        if (options.reasoningId) store.setEffort(sessionKey, options.reasoningId as never);
        store.setPlanMode(sessionKey, options.mode === "plan");
        store.setFastMode(sessionKey, options.fastMode);
      } else if (platform === "codex") {
        const store = useCodexStore.getState();
        if (options.modelId) store.setSelectedModel(sessionKey, options.modelId);
        if (options.reasoningId) store.setSelectedReasoningEffort(sessionKey, options.reasoningId as never);
        store.setSelectedMode(sessionKey, options.mode);
        store.setFastMode(sessionKey, options.fastMode);
      } else if (platform === "opencode") {
        const store = useOpenCodeStore.getState();
        if (options.modelId) store.setSelectedModel(sessionKey, options.modelId);
        if (options.reasoningId) store.setSelectedVariant(sessionKey, options.reasoningId);
        store.setSelectedMode(sessionKey, options.mode);
      }
    }
    await persistLockedPane("send");
  }, [persistLockedPane, props.data.environmentId, props.tabId]);
  const lockAndResume = useCallback(async (platform: AgentPlatform) => {
    const selectedAdapter = findNativeAgentAdapter(platform);
    if (!selectedAdapter?.capabilities.resume) return;
    setAwaitingDurability(true);
    setDurabilityError(null);
    const paneStore = usePaneLayoutStore.getState();
    const lockedPlatform = paneStore.lockTabNativePlatform(
      props.tabId,
      platform,
      props.data.environmentId,
    );
    const lockedAdapter = lockedPlatform ? findNativeAgentAdapter(lockedPlatform) : undefined;
    if (!lockedPlatform || !lockedAdapter?.capabilities.resume) {
      setDurabilityError("This tab could not be opened for session resume.");
      setPendingDurabilityOperation(null);
      setAwaitingDurability(false);
      return;
    }
    setResumeRequestedPlatform(lockedPlatform);
    await persistLockedPane("resume");
  }, [persistLockedPane, props.data.environmentId, props.tabId]);

  // A tab whose platform has no adapter is a data problem, not a crash. Render
  // the mismatch instead of throwing out of the pane and taking its siblings
  // down with it.
  if (!props.data.platform) {
    return (
      <UnassignedNativeAgentComposer
        tabId={props.tabId}
        environmentId={props.data.environmentId}
        containerId={props.data.containerId}
        disabled={awaitingDurability}
        onSend={(platform, prompt, options) => { void lockAndSend(platform, prompt, options); }}
        onResume={(platform) => { void lockAndResume(platform); }}
      />
    );
  }
  if (awaitingDurability) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Saving agent choice…</div>;
  }
  if (durabilityError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-destructive">
        <p>{durabilityError}</p>
        {pendingDurabilityOperation ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => { void persistLockedPane(pendingDurabilityOperation); }}
          >
            Retry save
          </Button>
        ) : null}
      </div>
    );
  }
  if (!adapter || !Controller) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        This tab refers to an unsupported agent, so it cannot be opened.
      </div>
    );
  }

  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Connecting to {adapter.label}…
        </div>
      )}
    >
      <Controller
        {...props}
        initialResumeOpen={resumeRequestedPlatform === props.data.platform}
      />
    </Suspense>
  );
});
