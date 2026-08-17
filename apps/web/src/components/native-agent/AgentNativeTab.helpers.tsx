import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, History } from "lucide-react";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  resolveReasoningId,
  type AgentModel,
  type FallbackExecutionProfileId,
} from "@orkestrator/protocol/native-agent";
import { Button } from "@/components/ui/button";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeAttachmentMenu } from "@/components/chat/NativeAttachmentMenu";
import { NativeComposeBar } from "@/components/chat/NativeComposeBar";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
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
import { useComposerFileSearchFeedback } from "@/hooks/useComposerFileSearchFeedback";
import { useComposerMountFocus } from "@/hooks/useComposerMountFocus";
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import { useNativeComposeDraftPersistence } from "@/hooks/useNativeComposeDraftPersistence";
import { getNativeAgentModelCatalog } from "@/lib/backend";
import { buildInitialPromptWithAttachmentReferences } from "@/lib/initial-prompt-attachments";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  snapshotNativeAgentActivity,
  type NativeAgentActivitySnapshot,
} from "@/lib/chat/native-agent-pinning";
import {
  resolveWorkspaceAttachment,
  retainSupportedAttachments,
} from "@/lib/chat/workspace-attachments";
import { createSessionKey } from "@/lib/utils";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { syncCachedAcpModels } from "@/stores/agentModelCatalogStore";
import {
  nativeComposeDraft,
  unassignedNativeComposePersistenceStore,
  useNativeComposeStore,
} from "@/stores/nativeComposeStore";
import type { FileCandidate, FileMention } from "@/types";
import { toast } from "sonner";
import {
  findNativeAgentAdapter,
  nativeAgentAdapters,
} from "./adapter";

/**
 * Execution profiles offered before a tab is locked to a provider, and the
 * Plan/Build labels used on the locked OpenCode compose bar for those two ids.
 *
 * The real list is the provider's own primary-agent names, and every source for
 * it is keyed by a provider session id that does not exist until the tab locks:
 * the backend reads them from interactive session metadata, so there is no
 * session-free command to ask. The launcher therefore offers the pair OpenCode —
 * the only platform that reaches this control today — ships by default, and the
 * locked composer replaces them with the advertised list on first projection.
 * An id the provider turns out not to have is dropped by `projectionComposer`
 * rather than dispatched as an unknown agent name.
 *
 * Typed against `FallbackExecutionProfileId` so this list cannot grow past what
 * `updateProjectionControls` will accept without a listing to check against —
 * an extra entry here would render a control whose every selection 400s.
 */
export const LAUNCH_EXECUTION_PROFILES = [
  { id: "build", label: "Build" },
  { id: "plan", label: "Plan" },
] as const satisfies ReadonlyArray<{
  id: FallbackExecutionProfileId;
  label: string;
}>;

/**
 * The profile OpenCode itself falls back to when a prompt carries no agent.
 *
 * `opencode-provider` sends `agent: options.executionAgent ?? "build"`, so this
 * is the name a turn with no explicit selection runs under. The compose bar has
 * to show the same thing rather than the first entry of an unordered listing.
 */
export const DEFAULT_EXECUTION_PROFILE_ID: FallbackExecutionProfileId = "build";

/** Title-case the built-in OpenCode agents; leave custom primary agents as listed. */
export function nativeComposeProfileLabel(id: string, label?: string): string {
  if (id === "plan") return "Plan";
  if (id === "build") return "Build";
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : id;
}

function activeAgentSummary(snapshots: NativeAgentActivitySnapshot[]): string {
  const summaries: string[] = [];
  const activeAgents = snapshots.filter(
    (snapshot) => snapshot.kind === "subagent" && snapshot.status === "active",
  );
  if (activeAgents.length > 0) {
    const noun = activeAgents.length === 1 ? "sub-agent" : "sub-agents";
    summaries.push(
      `${activeAgents.length} ${noun} working: ${activeAgents.map((snapshot) => snapshot.label).join(", ")}.`,
    );
  }

  for (const status of ["pending", "running", "paused"] as const) {
    const tasks = snapshots.filter(
      (snapshot) => snapshot.kind === "background-task"
        && snapshot.backgroundTaskStatus === status,
    );
    if (tasks.length === 0) continue;
    const noun = tasks.length === 1 ? "background task" : "background tasks";
    const verb = status === "pending" ? "starting" : status;
    summaries.push(
      `${tasks.length} ${noun} ${verb}: ${tasks.map((snapshot) => snapshot.label).join(", ")}.`,
    );
  }

  return summaries.join(" ");
}

function backgroundTaskAnnouncementStatus(
  status: NativeAgentActivitySnapshot["backgroundTaskStatus"],
): string | undefined {
  switch (status) {
    case "pending": return "starting";
    case "running": return "running";
    case "paused": return "paused";
    case "completed": return "completed";
    case "failed": return "failed";
    case "killed": return "stopped";
    default: return undefined;
  }
}

interface NativeAgentActivityAnnouncement {
  text: string;
  /**
   * Increments on every announcement, including one identical to the last.
   * Two children can share a label — `nativeAgentActivityLabel` falls back to a
   * constant — so `setState` would bail out on the repeated string, leave the
   * live region's text node untouched, and silently drop the second
   * announcement. The shell keys the region on this instead.
   */
  seq: number;
}

export function useNativeAgentActivityAnnouncement(
  messages: NativeMessage[],
  scope: string,
): NativeAgentActivityAnnouncement {
  const snapshots = useMemo(() => snapshotNativeAgentActivity(messages), [messages]);
  const previousRef = useRef<{
    scope: string;
    snapshots: Map<string, NativeAgentActivitySnapshot>;
  } | null>(null);
  const [announcement, setAnnouncement] = useState<NativeAgentActivityAnnouncement>(
    { text: "", seq: 0 },
  );
  const announce = useCallback((text: string) => {
    setAnnouncement((previous) => ({ text, seq: previous.seq + 1 }));
  }, []);

  useEffect(() => {
    const current = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const previousState = previousRef.current;
    previousRef.current = { scope, snapshots: current };

    if (!previousState || previousState.scope !== scope) {
      announce(activeAgentSummary(snapshots));
      return;
    }

    const lifecycleUpdates: string[] = [];
    for (const [id, previous] of previousState.snapshots) {
      const next = current.get(id);
      if (
        previous.kind === "background-task"
        && next?.kind === "background-task"
        && previous.backgroundTaskStatus !== next.backgroundTaskStatus
      ) {
        const status = backgroundTaskAnnouncementStatus(next.backgroundTaskStatus);
        if (status) lifecycleUpdates.push(`${next.label} ${status}.`);
        continue;
      }
      if (previous.status !== "active" || !next || next.status === "active") continue;
      lifecycleUpdates.push(`${next.label} ${next.status === "failed" ? "failed" : "finished"}.`);
    }

    const activeChanged = snapshots.some((snapshot) => {
      if (snapshot.status !== "active") return false;
      const previous = previousState.snapshots.get(snapshot.id);
      if (snapshot.kind === "background-task") return previous === undefined;
      return previous?.status !== "active" || previous.label !== snapshot.label;
    });
    const summary = activeChanged ? activeAgentSummary(snapshots) : "";
    const nextAnnouncement = [...lifecycleUpdates, summary].filter(Boolean).join(" ");
    if (nextAnnouncement) announce(nextAnnouncement);
  }, [announce, scope, snapshots]);

  return announcement;
}

function PlatformIcon({ platform }: { platform: AgentPlatform }) {
  return <AgentPlatformIcon platform={platform} className="size-5" />;
}

export function extractNativePlanContent(messages: readonly NativeMessage[]): string | undefined {
  const looksLikePlan = (path: string) => {
    const normalized = path.toLowerCase();
    const filename = normalized.split("/").at(-1) ?? "";
    return /(^|[-_])plan\.md$/.test(filename)
      || /plan[-_].*\.md$/.test(filename)
      || [".claude/", "docs/plans/", "plans/"].some(
        (directory) => normalized.includes(directory) && normalized.endsWith(".md"),
      );
  };
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool-invocation" || part.toolName?.toLowerCase() !== "write") continue;
      const path = part.toolArgs?.file_path;
      const content = part.toolArgs?.content;
      if (typeof path === "string" && looksLikePlan(path) && typeof content === "string") {
        return content;
      }
    }
  }
  return undefined;
}

export function NativeAgentResumePlatformDialog({
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

export function UnassignedNativeAgentComposer({
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
      mode?: "build" | "plan";
      executionProfileId?: string;
    },
  ) => void;
  onResume: (platform: AgentPlatform) => void;
}) {
  const sessionKey = createSessionKey(environmentId, tabId);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const draft = useNativeComposeStore((state) => nativeComposeDraft(state, sessionKey));
  const hasDraft = useNativeComposeStore((state) => state.drafts.has(sessionKey));
  const updateStoreDraft = useNativeComposeStore((state) => state.updateDraft);
  const defaultPlatform = useConfigStore((state) => state.config.global.defaultAgent ?? "claude");
  const globalConfig = useConfigStore((state) => state.config.global);
  const environment = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId),
  );
  const worktreePath = environment?.worktreePath;
  const { favorites, enabledPlatforms, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
  const [resumePlatformDialogOpen, setResumePlatformDialogOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const platform = draft.platform ?? defaultPlatform;
  const selectedAdapter = findNativeAgentAdapter(platform);
  const platformFastModeDefault = platform === "claude"
    ? globalConfig.claudeNativeFastModeDefault ?? false
    : platform === "codex"
      ? globalConfig.codexNativeFastModeDefault ?? false
      : false;
  const effectiveFastMode = hasDraft ? draft.fastMode : platformFastModeDefault;
  const updateDraft = useCallback((
    key: string,
    update: Partial<typeof draft>,
  ) => {
    const current = useNativeComposeStore.getState().drafts.get(key);
    const nextPlatform = update.platform ?? current?.platform ?? platform;
    const defaultFastMode = nextPlatform === "claude"
      ? useConfigStore.getState().config.global.claudeNativeFastModeDefault ?? false
      : nextPlatform === "codex"
        ? useConfigStore.getState().config.global.codexNativeFastModeDefault ?? false
        : false;
    updateStoreDraft(key, {
      ...(current ? {} : { fastMode: defaultFastMode }),
      ...update,
    });
  }, [platform, updateStoreDraft]);
  useNativeComposeDraftPersistence(
    "agent-native",
    environmentId,
    sessionKey,
    unassignedNativeComposePersistenceStore,
  );
  // The catalogue is environment-scoped and already carries every platform, so
  // it must not be refetched when the platform draft changes: `platformModels`
  // filters it client-side. Re-running here would clear the list and re-issue a
  // command that probes both ACP bridges, flashing "No models available" on
  // every switch.
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    void getNativeAgentModelCatalog(environmentId)
      .then((catalog) => {
        // The backend has already normalized and durably cached these models.
        // Mirror its response so every other mounted launcher updates without
        // each picker performing its own storage read.
        syncCachedAcpModels(catalog);
        if (!cancelled) setModels(catalog);
      })
      .catch((error) => {
        console.warn("[AgentNativeTab] Failed to load native model catalogue:", error);
      });
    return () => { cancelled = true; };
  }, [environmentId]);
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
  const canConfigureReasoning = selectedAdapter?.capabilities.composer.reasoning === true;
  const canConfigureMode = selectedAdapter?.capabilities.composer.mode === true;
  // Capability, not platform: a tab that has no conversation mode but does have
  // execution profiles needs *some* way to pick one, because the opening prompt
  // is dispatched before the user can reach the locked composer.
  const canConfigureExecutionProfile = !canConfigureMode
    && selectedAdapter?.capabilities.composer.executionProfile === true;
  // A draft restored from a platform whose profiles differ, or persisted before
  // this list changed, can name a profile the launcher cannot show. Fall back to
  // the default rather than rendering a radio group with nothing selected.
  const selectedLaunchExecutionProfile = LAUNCH_EXECUTION_PROFILES.find(
    (profile) => profile.id === draft.executionProfileId,
  ) ?? LAUNCH_EXECUTION_PROFILES[0];
  // The catalogue's `supportsSpeed` describes the model; the table describes the
  // platform. Both have to allow it, so a catalogue entry cannot reintroduce a
  // toggle the platform has no way to apply.
  const canConfigureSpeed = selectedAdapter?.capabilities.composer.speed === true
    && selectedModel?.supportsSpeed === true;
  const selectedReasoningId = resolveReasoningId(
    selectedModel?.reasoning ?? [],
    draft.reasoningId,
    selectedModel?.defaultReasoningId,
  ) ?? selectedModel?.defaultReasoningId;
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
  const handleWorkspaceFileMention = useCallback((file: FileCandidate) => {
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
  const handleWorkspaceFileAttach = useCallback((file: FileCandidate) => {
    const current = useNativeComposeStore.getState().drafts.get(sessionKey);
    const resolved = resolveWorkspaceAttachment(file, {
      containerId,
      worktreePath,
      allowFiles: selectedAdapter?.capabilities.attachments.files === true,
      allowImages: selectedAdapter?.capabilities.attachments.images === true,
      modelSupportsImages: selectedModel?.supportsImageInput,
      modelLabel: selectedModel?.label,
      attachedCount: current?.attachments.length ?? 0,
    });
    if ("error" in resolved) {
      toast.error(resolved.error, { description: resolved.description });
      return;
    }
    updateDraft(sessionKey, {
      attachments: [...(current?.attachments ?? []), resolved.attachment],
    });
  }, [
    containerId,
    selectedAdapter,
    selectedModel?.label,
    selectedModel?.supportsImageInput,
    sessionKey,
    updateDraft,
    worktreePath,
  ]);
  const canAttachImage = useCallback(
    () => selectedAdapter?.capabilities.attachments.images === true
      && selectedModel?.supportsImageInput !== false,
    [selectedAdapter, selectedModel?.supportsImageInput],
  );
  /*
   * A draft restored from persistence predates the selected provider, so its
   * attachments may be ones this agent refuses. Reconcile against the neutral
   * capabilities rather than trusting the persisted namespace: a bridge that
   * rejects the whole prompt would otherwise fail a send the composer had no
   * way to explain.
   */
  const attachmentCapabilities = selectedAdapter?.capabilities.attachments;
  useEffect(() => {
    const current = useNativeComposeStore.getState().drafts.get(sessionKey);
    if (!current || current.attachments.length === 0) return;
    const supported = retainSupportedAttachments(
      current.attachments,
      attachmentCapabilities,
    );
    if (supported.length === current.attachments.length) return;
    updateDraft(sessionKey, { attachments: supported });
  }, [attachmentCapabilities, sessionKey, updateDraft]);
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
  useComposerFileSearchFeedback({
    error: fileSearch.error,
    refresh: fileSearch.refresh,
    mentionMenuOpen: fileMentionMenuOpen,
  });
  useComposerMountFocus(inputRef);

  const send = () => {
    const prompt = buildInitialPromptWithAttachmentReferences(
      serializeForLLM(draft.text, draft.mentions),
      draft.attachments.map(({ name, path }) => ({ name, path })),
    );
    if (!prompt || disabled) return;
    onSend(platform, prompt, {
      modelId: selectedModel?.id,
      reasoningId: selectedReasoningId,
      fastMode: canConfigureSpeed && effectiveFastMode,
      // A platform with no conversation mode must not pin one on the locked
      // tab. OpenCode would receive it as the SDK `agent` name.
      ...(canConfigureMode ? { mode: draft.mode } : {}),
      // Read from the resolved selection, not the raw draft: the trigger renders
      // the same value, and dispatching an id the launcher never displayed is
      // exactly the display/dispatch split this control exists to close.
      ...(canConfigureExecutionProfile ? {
        executionProfileId: selectedLaunchExecutionProfile.id,
      } : {}),
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
            if (event.key === "Tab" && event.shiftKey && canConfigureMode) {
              event.preventDefault();
              updateDraft(sessionKey, { mode: draft.mode === "plan" ? "build" : "plan" });
              return;
            }
            if (event.key === "Tab" && event.shiftKey && canConfigureExecutionProfile) {
              event.preventDefault();
              const index = LAUNCH_EXECUTION_PROFILES.findIndex(
                (profile) => profile.id === selectedLaunchExecutionProfile.id,
              );
              const next = LAUNCH_EXECUTION_PROFILES[
                (index + 1) % LAUNCH_EXECUTION_PROFILES.length
              ];
              if (next) updateDraft(sessionKey, { executionProfileId: next.id });
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
              {selectedAdapter?.capabilities.attachments.files
                || selectedAdapter?.capabilities.attachments.images ? (
                <NativeAttachmentMenu
                  disabled={disabled}
                  fileSearch={fileSearch}
                  onSelectFile={handleWorkspaceFileAttach}
                  onMentionFile={handleWorkspaceFileMention}
                  onCloseAutoFocus={() => inputRef.current?.focus()}
                  filePickerDescription="Search this environment and attach a file to the first prompt."
                  mentionPickerDescription="Search this environment and mention a file in the first prompt."
                />
              ) : null}
              <AgentModelPicker
                models={models}
                favorites={favorites}
                enabledPlatforms={enabledPlatforms}
                selectedPlatform={platform}
                onPlatformChange={(next) => {
                  // The picker announces the platform on every model choice, not
                  // only when it changes. Resetting unconditionally would clear
                  // the model and effort the user just picked on this provider.
                  const current = useNativeComposeStore.getState().drafts.get(sessionKey);
                  if ((current?.platform ?? platform) === next) return;
                  const nextAdapter = findNativeAgentAdapter(next);
                  updateDraft(sessionKey, {
                    platform: next,
                    modelId: undefined,
                    reasoningId: undefined,
                    executionProfileId: undefined,
                    fastMode: next === "claude"
                      ? globalConfig.claudeNativeFastModeDefault ?? false
                      : next === "codex"
                        ? globalConfig.codexNativeFastModeDefault ?? false
                        : false,
                    // Per type, not all-or-nothing: Codex takes images and
                    // refuses files, and its bridge rejects the entire prompt
                    // rather than dropping the entry it cannot use.
                    attachments: retainSupportedAttachments(
                      draft.attachments,
                      nextAdapter?.capabilities.attachments,
                    ),
                  });
                }}
                onToggleFavorite={toggleFavorite}
                onReorderFavorites={reorderFavorites}
                selectedModelId={selectedModel?.id}
                selectedModelLabel={selectedModel?.label ?? "No models available"}
                onModelChange={(modelId) => {
                  // Platform selection is applied synchronously by the picker
                  // before model selection. Read it back from the neutral draft so
                  // identical provider-local model ids cannot route to the first
                  // matching catalog entry from another provider. The reasoning id
                  // comes from that same fresh snapshot: a platform switch clears
                  // it, and the render closure still holds the old provider's
                  // value, which would otherwise be carried across the switch.
                  const currentDraft = useNativeComposeStore.getState().drafts.get(sessionKey);
                  const selectedPlatform = currentDraft?.platform ?? platform;
                  const model = models.find((candidate) =>
                    candidate.platform === selectedPlatform && candidate.id === modelId,
                  );
                  updateDraft(sessionKey, {
                    modelId,
                    platform: selectedPlatform,
                    reasoningId: resolveReasoningId(
                      model?.reasoning ?? [],
                      currentDraft?.reasoningId,
                      model?.defaultReasoningId,
                    ) ?? model?.defaultReasoningId,
                  });
                }}
                reasoningOptions={selectedModel?.reasoning ?? []}
                selectedReasoningId={selectedReasoningId}
                selectedReasoningLabel={selectedReasoningLabel}
                onReasoningChange={canConfigureReasoning ? (reasoningId) => updateDraft(sessionKey, { reasoningId }) : undefined}
                fastModeEnabled={effectiveFastMode}
                fastModeAvailable={canConfigureSpeed}
                speedCapable={selectedAdapter?.capabilities.composer.speed === true}
                onFastModeChange={(fastMode) => updateDraft(sessionKey, { fastMode })}
                disabled={disabled}
              />
              {canConfigureMode ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
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
              ) : canConfigureExecutionProfile ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label="Execution profile"
                      className="h-8 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                    >
                      {selectedLaunchExecutionProfile.label}
                      <ChevronDown className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={selectedLaunchExecutionProfile.id}
                      onValueChange={(executionProfileId) => updateDraft(sessionKey, {
                        executionProfileId,
                      })}
                    >
                      {LAUNCH_EXECUTION_PROFILES.map((profile) => (
                        <DropdownMenuRadioItem key={profile.id} value={profile.id}>
                          {profile.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
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
