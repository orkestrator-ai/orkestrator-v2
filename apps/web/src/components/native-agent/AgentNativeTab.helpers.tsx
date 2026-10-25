import { resolvedDefaultAgent, resolvedPlatformSettings } from "@/lib/agent-settings";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { History } from "lucide-react";
import {
  AGENT_PLATFORMS,
  firstEnabledAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { isPlanMarkdownPath } from "@orkestrator/protocol/agent-interactions";
import {
  nativeAgentApprovalModes,
  resolveNativeAgentApprovalMode,
  resolveReasoningId,
  type AgentModel,
  type AgentModelRef,
  type FallbackExecutionProfileId,
} from "@orkestrator/protocol/native-agent";
import { Button } from "@/components/ui/button";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import {
  approvalModeIconOption,
  ComposerIconPicker,
  conversationModeIconOption,
} from "@/components/chat/ComposerIconPicker";
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
  mergeReorderedFavoriteModels,
  useAgentModelFavorites,
} from "@/hooks/useAgentModelFavorites";
import { useFileMentions } from "@/hooks/useFileMentions";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useComposerFileSearchFeedback } from "@/hooks/useComposerFileSearchFeedback";
import { useComposerMountFocus } from "@/hooks/useComposerMountFocus";
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import { useNativeComposeDraftPersistence } from "@/hooks/useNativeComposeDraftPersistence";
import { getNativeAgentModelCatalog } from "@/lib/backend";
import { hydrateAgentModelCatalogCache } from "@/lib/agent-model-catalog-cache";
import { MODEL_CATALOG_REFRESHED_EVENT } from "@/components/settings/agent/refresh-model-catalog";
import { buildInitialPromptWithAttachmentReferences } from "@/lib/initial-prompt-attachments";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import {
  buildPromptWithTranscriptAnnotations,
  sendableTranscriptAnnotations,
} from "@/lib/chat/transcript-annotations";
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
import { findNativeAgentAdapter, nativeAgentAdapters } from "./adapter";

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
      (snapshot) => snapshot.kind === "background-task" && snapshot.backgroundTaskStatus === status,
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
    case "pending":
      return "starting";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
    default:
      return undefined;
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
  const [announcement, setAnnouncement] = useState<NativeAgentActivityAnnouncement>({
    text: "",
    seq: 0,
  });
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
        previous.kind === "background-task" &&
        next?.kind === "background-task" &&
        previous.backgroundTaskStatus !== next.backgroundTaskStatus
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
  // createPlan bodies are deferred behind detailRef in projected messages and
  // render through PlanToolPart. This synchronous fallback is only for plan
  // files whose bounded content remains in toolArgs.
  const fromParts = (parts: readonly NativeMessagePart[]): string | undefined => {
    for (const part of [...parts].reverse()) {
      if (part.type === "tool-invocation" && part.toolName?.toLowerCase() === "write") {
        const path = part.toolArgs?.file_path;
        const content = part.toolArgs?.content;
        if (typeof path === "string" && isPlanMarkdownPath(path) && typeof content === "string") {
          return content;
        }
      }
      if (part.type === "tool-group" || part.type === "agent-group") {
        const nested = fromParts(part.parts);
        if (nested !== undefined) return nested;
      }
      if (part.type === "task-group") {
        const nested = fromParts([part.task, ...part.childTools]);
        if (nested !== undefined) return nested;
      }
      if (part.type === "subagent" && part.subagentActions) {
        const nested = fromParts(part.subagentActions);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const content = fromParts(message.parts);
    if (content !== undefined) return content;
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
                    {canResume
                      ? "Choose a previous session"
                      : "Session resume is not available yet"}
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
  projectId,
  platformFilter,
  platformNotes,
  placeholder,
  emptyPlatformsMessage,
  workspacePath,
  writeImage,
  initialAgentPlatform,
  initialAgentModel,
  initialReasoningEffort,
  initialConversationMode,
  initialFastMode,
  initialExecutionProfileId,
  offerApprovalModes = true,
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
      approvalMode?: string;
    },
  ) => void;
  /** False where the session's policy is fixed, as a coordinator's is. */
  offerApprovalModes?: boolean;
  /**
   * Omitted where resuming makes no sense.
   *
   * A coordinator conversation owns its provider session; adopting an arbitrary
   * rollout into one would attach a transcript the workspace has no record of.
   */
  onResume?: (platform: AgentPlatform) => void;
  /**
   * The project whose defaults apply when no Environment record exists.
   *
   * A coordinator runtime deliberately has no Environment, so without this the
   * repository's model and effort defaults would be skipped and every
   * conversation would start on the application default instead.
   */
  projectId?: string;
  /** Narrows the offered platforms further, e.g. to those a coordinator qualifies. */
  platformFilter?: readonly AgentPlatform[];
  /**
   * Per-platform caveat shown inside the picker, such as a weaker read-only
   * boundary or a mailbox that cannot deliver a worker's reply.
   */
  platformNotes?: Partial<Record<AgentPlatform, string>>;
  placeholder?: string;
  emptyPlatformsMessage?: string;
  /**
   * The workspace to search and attach files from when no Environment record
   * exists. A coordinator runtime has none, and without this its opening
   * composer would offer neither file mentions nor workspace attachments.
   */
  workspacePath?: string;
  /**
   * Trusted writer for a runtime whose attachments live outside a workspace.
   *
   * Supplying it also stops a pasted image being written into `workspacePath`:
   * a read-only coordinator's workspace is the user's own checkout.
   */
  writeImage?: (filename: string, base64Data: string) => Promise<string>;
  /** Create-dialog provider preselect; does not lock the tab. */
  initialAgentPlatform?: AgentPlatform;
  /** Create-dialog model preselect; does not lock the tab. */
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  initialConversationMode?: "build" | "plan";
  initialFastMode?: boolean;
  initialExecutionProfileId?: string;
}) {
  const sessionKey = createSessionKey(environmentId, tabId);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const draft = useNativeComposeStore((state) => nativeComposeDraft(state, sessionKey));
  const hasDraft = useNativeComposeStore((state) => state.drafts.has(sessionKey));
  const updateStoreDraft = useNativeComposeStore((state) => state.updateDraft);
  const config = useConfigStore((state) => state.config);
  const environment = useEnvironmentStore((state) => state.getEnvironmentById(environmentId));
  const worktreePath = environment?.worktreePath ?? workspacePath;
  const {
    favorites: allFavorites,
    enabledPlatforms: allEnabledPlatforms,
    toggleFavorite,
    reorderFavorites: reorderAllFavorites,
  } = useAgentModelFavorites();
  const enabledPlatforms = useMemo(
    () =>
      platformFilter
        ? allEnabledPlatforms.filter((candidate) => platformFilter.includes(candidate))
        : allEnabledPlatforms,
    [allEnabledPlatforms, platformFilter],
  );
  // Favourites are global. One on a platform this composer cannot start (a
  // coordinator's unqualified platform, or one switched off) would be a
  // selectable placeholder for a model it cannot run, so it is hidden here;
  // reordering keeps the hidden ones in their slots.
  const favorites = useMemo(
    () => allFavorites.filter((favorite) => enabledPlatforms.includes(favorite.platform)),
    [allFavorites, enabledPlatforms],
  );
  const reorderFavorites = useCallback(
    (reorderedVisible: AgentModelRef[]) => {
      const merged = mergeReorderedFavoriteModels(allFavorites, favorites, reorderedVisible);
      if (merged) reorderAllFavorites(merged);
    },
    [allFavorites, favorites, reorderAllFavorites],
  );
  // Same triple App overlay launches use: an environment or repository default
  // must win over the application one, constrained to platforms still enabled.
  const defaultPlatform = firstEnabledAgentPlatform(
    enabledPlatforms,
    resolvedDefaultAgent(config, environment?.projectId ?? projectId, environment),
  );
  const [resumePlatformDialogOpen, setResumePlatformDialogOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const modelCatalogRequestsRef = useRef(new Map<string, Promise<AgentModel[]>>());
  const modelCatalogInFlightRef = useRef(new Set<string>());
  const modelCatalogEnvironmentRef = useRef(environmentId);
  const modelCatalogMountedRef = useRef(false);
  const modelCatalogRetriedRef = useRef(new Set<string>());
  const [modelCatalogRetryRevision, setModelCatalogRetryRevision] = useState(0);
  const platform = draft.platform ?? defaultPlatform;
  const configured = resolvedPlatformSettings(
    config,
    environment?.projectId ?? projectId,
    environment,
    platform,
  );
  const selectedAdapter = findNativeAgentAdapter(platform);
  // A draft with no explicit choice follows the stored platform default, then
  // Normal. OpenCode has no toggle, so this stays false there.
  const effectiveFastMode = hasDraft ? draft.fastMode : (configured.fastMode ?? false);
  const updateDraft = useCallback(
    (key: string, update: Partial<typeof draft>) => {
      const current = useNativeComposeStore.getState().drafts.get(key);
      updateStoreDraft(key, {
        ...(current ? {} : { fastMode: configured.fastMode ?? false }),
        ...update,
      });
    },
    [configured.fastMode, updateStoreDraft],
  );
  // One-shot create-dialog choices are tab-owned so they survive the backend
  // consuming `pendingAgentLaunch`. Seed them into the draft without locking
  // the platform — a later picker change must win, and a platform switch must
  // not re-apply the original create-dialog model onto the new provider.
  const seededInitialPreselectRef = useRef(false);
  const configuredFastModeRef = useRef(configured.fastMode);
  // Declared before the seeding effect so it runs first in the same commit.
  useLayoutEffect(() => {
    configuredFastModeRef.current = configured.fastMode;
  }, [configured.fastMode]);
  useLayoutEffect(() => {
    if (seededInitialPreselectRef.current) return;
    const hasInitialPreselect = Boolean(
      initialAgentPlatform ||
      initialAgentModel ||
      initialReasoningEffort ||
      initialConversationMode ||
      typeof initialFastMode === "boolean" ||
      initialExecutionProfileId,
    );
    if (!hasInitialPreselect) return;
    const current = useNativeComposeStore.getState().drafts.get(sessionKey);
    const seeded: Partial<typeof draft> = {};
    if (initialAgentPlatform && current?.platform === undefined) {
      seeded.platform = initialAgentPlatform;
    }
    if (initialAgentModel && current?.modelId === undefined) {
      seeded.modelId = initialAgentModel;
    }
    if (initialReasoningEffort && current?.reasoningId === undefined) {
      seeded.reasoningId = initialReasoningEffort;
    }
    if (initialConversationMode && current === undefined) {
      seeded.mode = initialConversationMode;
    }
    if (typeof initialFastMode === "boolean" && current === undefined) {
      seeded.fastMode = initialFastMode;
    }
    if (initialExecutionProfileId && current?.executionProfileId === undefined) {
      seeded.executionProfileId = initialExecutionProfileId;
    }
    seededInitialPreselectRef.current = true;
    if (Object.keys(seeded).length === 0) return;
    updateStoreDraft(sessionKey, {
      ...(current ? {} : { fastMode: configuredFastModeRef.current ?? false }),
      ...seeded,
    });
  }, [
    initialAgentModel,
    initialAgentPlatform,
    initialConversationMode,
    initialExecutionProfileId,
    initialFastMode,
    initialReasoningEffort,
    sessionKey,
    updateStoreDraft,
  ]);
  const draftRestoreGeneration = useNativeComposeDraftPersistence(
    "agent-native",
    environmentId,
    sessionKey,
    unassignedNativeComposePersistenceStore,
  );
  useEffect(() => {
    modelCatalogMountedRef.current = true;
    return () => {
      modelCatalogMountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (modelCatalogEnvironmentRef.current === environmentId) return;
    modelCatalogEnvironmentRef.current = environmentId;
    modelCatalogRequestsRef.current.clear();
    modelCatalogInFlightRef.current.clear();
    modelCatalogRetriedRef.current.clear();
    setModels([]);
  }, [environmentId]);
  // A normal read remains side-effect free. On the first selection of a
  // bridge-backed platform, however, tell the backend which one the user needs:
  // if its durable list is missing, the backend starts that bridge and seeds the
  // cache from `/global/models`. Requests are memoized per environment/platform
  // so switching the picker never clears the catalogue or repeatedly starts a
  // provider whose account genuinely has no models.
  useEffect(() => {
    // Every platform is asked for by name, so whichever one the user has
    // switched on downloads its list on first use.
    const ensureAgent = platform;
    const requestKey = `${environmentId}:${ensureAgent}`;
    if (models.some((model) => model.platform === ensureAgent)) return;
    if (modelCatalogRequestsRef.current.has(requestKey)) return;
    const request = getNativeAgentModelCatalog(environmentId, ensureAgent);
    modelCatalogRequestsRef.current.set(requestKey, request);
    modelCatalogInFlightRef.current.add(requestKey);
    void request
      .then((catalog) => {
        modelCatalogInFlightRef.current.delete(requestKey);
        modelCatalogRetriedRef.current.delete(requestKey);
        // The backend has already normalized and durably cached these models.
        // Mirror its response even if this tab became inactive while first-use
        // discovery ran, so every other mounted launcher sees the new snapshot.
        syncCachedAcpModels(catalog);
        // A first-run download lands in the backend's durable cache only; pull
        // it into the store the launch dialogs read from.
        if (catalog.some((model) => model.platform === ensureAgent)) {
          void hydrateAgentModelCatalogCache().catch(() => undefined);
        }
        if (
          !modelCatalogMountedRef.current ||
          modelCatalogEnvironmentRef.current !== environmentId
        ) {
          return;
        }
        setModels((current) => {
          // Two first-use bridge starts can overlap if the user switches quickly.
          // Preserve a non-empty platform from either response rather than
          // letting whichever older snapshot settles last erase it.
          const refreshedPlatforms = new Set(catalog.map((model) => model.platform));
          return [
            ...catalog,
            ...current.filter((model) => !refreshedPlatforms.has(model.platform)),
          ];
        });
      })
      .catch((error) => {
        modelCatalogInFlightRef.current.delete(requestKey);
        if (modelCatalogRequestsRef.current.get(requestKey) === request) {
          modelCatalogRequestsRef.current.delete(requestKey);
        }
        // The backend distinguishes a legitimate empty catalogue (which
        // resolves normally) from a transient bridge/fetch failure (which
        // rejects here). Retry the latter once automatically; further failures
        // remain manually retryable by switching platforms, without creating a
        // background restart loop for an unavailable provider.
        if (
          modelCatalogMountedRef.current &&
          modelCatalogEnvironmentRef.current === environmentId &&
          !modelCatalogRetriedRef.current.has(requestKey)
        ) {
          modelCatalogRetriedRef.current.add(requestKey);
          setModelCatalogRetryRevision((revision) => revision + 1);
        }
        console.warn("[AgentNativeTab] Failed to load native model catalogue:", error);
      });
  }, [environmentId, modelCatalogRetryRevision, models, platform]);
  // A host that was not signed in when the picker first asked has nothing to
  // list. Focus is a useful retry signal for host probes after an external
  // sign-in, but must not restart environment bridges (Cursor, Grok or Pi).
  // An explicit Settings refresh may update any platform. Never invalidate a
  // request that is still in flight.
  useEffect(() => {
    const retryEmptyPlatform = (includeBridgeBacked: boolean) => {
      if (models.some((model) => model.platform === platform)) return;
      if (
        !includeBridgeBacked &&
        platform !== "claude" &&
        platform !== "codex" &&
        platform !== "opencode"
      ) {
        return;
      }
      const requestKey = `${environmentId}:${platform}`;
      if (modelCatalogInFlightRef.current.has(requestKey)) return;
      modelCatalogRequestsRef.current.delete(requestKey);
      modelCatalogRetriedRef.current.delete(requestKey);
      setModelCatalogRetryRevision((revision) => revision + 1);
    };
    const retryHostOnFocus = () => retryEmptyPlatform(false);
    const retryAfterRefresh = () => retryEmptyPlatform(true);
    window.addEventListener("focus", retryHostOnFocus);
    window.addEventListener(MODEL_CATALOG_REFRESHED_EVENT, retryAfterRefresh);
    return () => {
      window.removeEventListener("focus", retryHostOnFocus);
      window.removeEventListener(MODEL_CATALOG_REFRESHED_EVENT, retryAfterRefresh);
    };
  }, [environmentId, models, platform]);
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
  const configuredModel = configured.model
    ? models.find((model) => model.platform === platform && model.id === configured.model)
    : undefined;
  const selectedModel =
    models.find((model) => model.id === draft.modelId && model.platform === platform) ??
    configuredModel ??
    platformModels[0];
  const canConfigureReasoning = selectedAdapter?.capabilities.composer.reasoning === true;
  const canConfigureMode = selectedAdapter?.capabilities.composer.mode === true;
  // Capability, not platform: a tab that has no conversation mode but does have
  // execution profiles needs *some* way to pick one, because the opening prompt
  // is dispatched before the user can reach the locked composer.
  const canConfigureExecutionProfile =
    !canConfigureMode && selectedAdapter?.capabilities.composer.executionProfile === true;
  // A draft restored from a platform whose profiles differ, or persisted before
  // this list changed, can name a profile the launcher cannot show. Fall back to
  // the default rather than rendering a radio group with nothing selected.
  const selectedLaunchExecutionProfile =
    LAUNCH_EXECUTION_PROFILES.find((profile) => profile.id === draft.executionProfileId) ??
    LAUNCH_EXECUTION_PROFILES[0];
  // The backend resolves the session's policy from these same environment
  // settings and caps whatever is chosen here, so this list is only the offer.
  const environmentApprovals = environment?.agentSettings?.executionPolicy?.approvals;
  // Match backend boundary reconciliation: restricting a full-network
  // container also requires an inner provider sandbox.
  const launchSandbox =
    environment?.environmentType === "containerized" &&
    environment.agentSettings?.executionPolicy?.sandbox !== "provider" &&
    !(
      environment.networkAccessMode === "full" &&
      environment.agentSettings?.executionPolicy?.networkAccess === "restricted"
    )
      ? ("container" as const)
      : undefined;
  const { launchApprovalModes, selectedLaunchApprovalMode } = useMemo(() => {
    const policy = {
      approvals: environmentApprovals ?? ("auto-approve" as const),
      ...(launchSandbox ? { sandbox: launchSandbox } : {}),
    };
    return {
      launchApprovalModes: offerApprovalModes ? nativeAgentApprovalModes(platform, policy) : [],
      selectedLaunchApprovalMode: resolveNativeAgentApprovalMode(
        platform,
        policy,
        draft.approvalMode,
      ),
    };
  }, [draft.approvalMode, environmentApprovals, launchSandbox, offerApprovalModes, platform]);
  // The catalogue's `supportsSpeed` describes the model; the table describes the
  // platform. Both have to allow it, so a catalogue entry cannot reintroduce a
  // toggle the platform has no way to apply.
  const canConfigureSpeed =
    selectedAdapter?.capabilities.composer.speed === true && selectedModel?.supportsSpeed === true;
  const selectedReasoningId =
    resolveReasoningId(
      selectedModel?.reasoning ?? [],
      draft.reasoningId ??
        (draft.modelId === undefined && selectedModel?.id === configured.model
          ? configured.reasoningEffort
          : undefined),
      selectedModel?.defaultReasoningId,
    ) ?? selectedModel?.defaultReasoningId;
  const selectedReasoningLabel =
    selectedModel?.reasoning?.find((option) => option.id === selectedReasoningId)?.label ??
    "Default";
  const handleTextAndMentionsChange = useCallback(
    (text: string, mentions: FileMention[]) => updateDraft(sessionKey, { text, mentions }),
    [sessionKey, updateDraft],
  );
  const handleFileMentionSelect = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      closeFileMentionMenu({ suppressReopenFor: file.filename });
      inputRef.current?.insertMention(mention);
    },
    [closeFileMentionMenu, createMention],
  );
  const handleWorkspaceFileMention = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      closeFileMentionMenu({ suppressReopenFor: file.filename });
      inputRef.current?.insertMentionAtCursor(mention);
    },
    [closeFileMentionMenu, createMention],
  );
  const handlePastedImage = useCallback(
    (attachment: { id: string; type: "image"; path: string; previewUrl: string; name: string }) => {
      const current = useNativeComposeStore.getState().drafts.get(sessionKey);
      updateDraft(sessionKey, {
        attachments: [...(current?.attachments ?? []), attachment],
      });
    },
    [sessionKey, updateDraft],
  );
  const handleWorkspaceFileAttach = useCallback(
    (file: FileCandidate) => {
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
    },
    [
      containerId,
      selectedAdapter,
      selectedModel?.label,
      selectedModel?.supportsImageInput,
      sessionKey,
      updateDraft,
      worktreePath,
    ],
  );
  const canAttachImage = useCallback(
    () =>
      selectedAdapter?.capabilities.attachments.images === true &&
      selectedModel?.supportsImageInput !== false,
    [selectedAdapter, selectedModel?.supportsImageInput],
  );
  /*
   * A draft restored from persistence predates the selected provider, so its
   * attachments may be ones this agent refuses. Reconcile against the neutral
   * capabilities rather than trusting the persisted namespace: a bridge that
   * rejects the whole prompt would otherwise fail a send the composer had no
   * way to explain.
   *
   * It runs when the capabilities change and once more when persistence
   * applies a restored draft. An undecided draft (no saved platform) is kept
   * whole by restoration, so without the second trigger a file could sit in an
   * image-only default composer until the provider happened to change. The
   * filter is idempotent, so the write it causes cannot re-trigger it.
   */
  const attachmentCapabilities = selectedAdapter?.capabilities.attachments;
  useEffect(() => {
    const current = useNativeComposeStore.getState().drafts.get(sessionKey);
    if (!current || current.attachments.length === 0) return;
    const supported = retainSupportedAttachments(current.attachments, attachmentCapabilities);
    if (supported.length === current.attachments.length) return;
    updateDraft(sessionKey, { attachments: supported });
  }, [attachmentCapabilities, draftRestoreGeneration, sessionKey, updateDraft]);
  const handleImageRejected = useCallback(
    () => toast.error("Images are not supported by this agent"),
    [],
  );

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath: writeImage ? undefined : worktreePath,
    writeImage,
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

  // Annotations (a design context, a quoted excerpt) join the first prompt the
  // same way the locked composer adds them to every later one.
  const hasSendableAnnotations = sendableTranscriptAnnotations(draft.annotations).length > 0;
  const send = () => {
    const prompt = buildPromptWithTranscriptAnnotations(
      buildInitialPromptWithAttachmentReferences(
        serializeForLLM(draft.text, draft.mentions),
        draft.attachments.map(({ name, path }) => ({ name, path })),
      ),
      draft.annotations,
    );
    if (!prompt.trim() || disabled) return;
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
      ...(canConfigureExecutionProfile
        ? {
            executionProfileId: selectedLaunchExecutionProfile.id,
          }
        : {}),
      ...(launchApprovalModes.length > 0 && selectedLaunchApprovalMode
        ? { approvalMode: selectedLaunchApprovalMode }
        : {}),
    });
  };

  // Nothing to choose from is a real state once a filter applies: every
  // platform may be disabled, or none may meet the host's safety level.
  // Rendering the composer anyway would offer a Send button that can only fail.
  if (enabledPlatforms.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <p className="max-w-md text-sm text-muted-foreground">
          {emptyPlatformsMessage ??
            "No agent platform is available here. Enable one in Settings to continue."}
        </p>
      </div>
    );
  }

  return (
    <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <NativeComposeDock
        centered
        actions={
          onResume ? (
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
          ) : null
        }
      >
        <NativeComposeBar
          testId="unassigned-native-compose-bar"
          layout="centered"
          attachments={draft.attachments}
          onRemoveAttachment={(attachmentId) =>
            updateDraft(sessionKey, {
              attachments: draft.attachments.filter((candidate) => candidate.id !== attachmentId),
            })
          }
          annotations={draft.annotations}
          onClearAnnotations={() => {
            if (disabled) return;
            const annotationIds = new Set(draft.annotations.map((annotation) => annotation.id));
            updateDraft(sessionKey, {
              annotations: [],
              attachments: draft.attachments.filter(
                (attachment) =>
                  !attachment.annotationId || !annotationIds.has(attachment.annotationId),
              ),
            });
          }}
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
              const next =
                LAUNCH_EXECUTION_PROFILES[(index + 1) % LAUNCH_EXECUTION_PROFILES.length];
              if (next) updateDraft(sessionKey, { executionProfileId: next.id });
              return;
            }
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
          placeholder={placeholder ?? "Ask an agent anything…"}
          disabled={disabled}
          menus={
            fileMentionMenuOpen ? (
              <FileMentionMenu
                files={filteredFiles}
                selectedIndex={fileMentionSelectedIndex}
                onSelect={handleFileMentionSelect}
                onClose={closeFileMentionMenu}
              />
            ) : null
          }
          primaryControls={
            <>
              {selectedAdapter?.capabilities.attachments.files ||
              selectedAdapter?.capabilities.attachments.images ? (
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
                platformNotes={platformNotes}
                selectedPlatform={platform}
                onPlatformChange={(next) => {
                  // The picker announces the platform on every model choice, not
                  // only when it changes. Resetting unconditionally would clear
                  // the model and effort the user just picked on this provider.
                  const current = useNativeComposeStore.getState().drafts.get(sessionKey);
                  if ((current?.platform ?? platform) === next) return;
                  const nextAdapter = findNativeAgentAdapter(next);
                  const nextFastMode = resolvedPlatformSettings(
                    config,
                    environment?.projectId ?? projectId,
                    environment,
                    next,
                  ).fastMode;
                  updateDraft(sessionKey, {
                    platform: next,
                    modelId: undefined,
                    reasoningId: undefined,
                    executionProfileId: undefined,
                    approvalMode: undefined,
                    fastMode: nextFastMode ?? false,
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
                  const model = models.find(
                    (candidate) =>
                      candidate.platform === selectedPlatform && candidate.id === modelId,
                  );
                  updateDraft(sessionKey, {
                    modelId,
                    platform: selectedPlatform,
                    reasoningId:
                      resolveReasoningId(
                        model?.reasoning ?? [],
                        currentDraft?.reasoningId,
                        model?.defaultReasoningId,
                      ) ?? model?.defaultReasoningId,
                  });
                }}
                reasoningOptions={selectedModel?.reasoning ?? []}
                selectedReasoningId={selectedReasoningId}
                selectedReasoningLabel={selectedReasoningLabel}
                onReasoningChange={
                  canConfigureReasoning
                    ? (reasoningId) => updateDraft(sessionKey, { reasoningId })
                    : undefined
                }
                fastModeEnabled={effectiveFastMode}
                fastModeAvailable={canConfigureSpeed}
                speedCapable={selectedAdapter?.capabilities.composer.speed === true}
                onFastModeChange={(fastMode) => updateDraft(sessionKey, { fastMode })}
                disabled={disabled}
              />
              {canConfigureMode ? (
                <ComposerIconPicker
                  label="Mode"
                  testId="launch-mode-picker"
                  disabled={disabled}
                  options={LAUNCH_EXECUTION_PROFILES.map((profile) =>
                    conversationModeIconOption(profile.id, profile.label),
                  )}
                  value={draft.mode}
                  onValueChange={(mode) =>
                    updateDraft(sessionKey, { mode: mode as "build" | "plan" })
                  }
                />
              ) : canConfigureExecutionProfile ? (
                <ComposerIconPicker
                  label="Mode"
                  testId="launch-execution-profile-picker"
                  disabled={disabled}
                  options={LAUNCH_EXECUTION_PROFILES.map((profile) =>
                    conversationModeIconOption(profile.id, profile.label),
                  )}
                  value={selectedLaunchExecutionProfile.id}
                  onValueChange={(executionProfileId) =>
                    updateDraft(sessionKey, { executionProfileId })
                  }
                />
              ) : null}
              {launchApprovalModes.length > 0 ? (
                <ComposerIconPicker
                  label="Approvals"
                  testId="launch-approval-mode-picker"
                  disabled={disabled}
                  options={launchApprovalModes.map(approvalModeIconOption)}
                  value={selectedLaunchApprovalMode}
                  onValueChange={(approvalMode) => updateDraft(sessionKey, { approvalMode })}
                />
              ) : null}
            </>
          }
          sendDisabled={
            disabled ||
            (!draft.text.trim() && draft.attachments.length === 0 && !hasSendableAnnotations)
          }
          sendTitle="Start agent"
          onSend={send}
        />
      </NativeComposeDock>
      {onResume ? (
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
      ) : null}
    </div>
  );
}
