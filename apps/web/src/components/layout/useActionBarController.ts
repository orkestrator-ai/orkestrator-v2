import {
  agentSettingsTiers,
  resolvedActionDefault,
  resolvedDefaultAgent,
} from "@/lib/agent-settings";
import {
  resolveActionDefaults,
  resolveAgentPlatformSettings,
} from "@orkestrator/protocol/agent-settings";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  useUIStore,
  useEnvironmentStore,
  useProjectStore,
  useConfigStore,
  useFilesPanelStore,
  useLoopedReviewStore,
  useMultiReviewStore,
} from "@/stores";
import { useShallow } from "zustand/react/shallow";
import { useTerminalContext, MAX_TABS, type AgentLaunchModeOverride } from "@/contexts";
import type { DefaultAgent } from "@/types";
import { resolveActionDefault, type ActionDefaultKey } from "@orkestrator/protocol/action-defaults";
import { usePullRequest, useProjects, useEnvironments } from "@/hooks";
import {
  createPRPrompt,
  createReviewPrompt,
  createPushChangesPrompt,
  createResolveConflictsPrompt,
  createOrkestratorScriptPrompt,
} from "@/prompts";
import * as backend from "@/lib/backend";
import { useKanbanStore, findTaskForEnvironment } from "@/stores/kanbanStore";
import { getEnvironmentBrowserUrl, getEnvironmentPortAddress } from "@/lib/environment-address";
import { isGatewayBrowserPreviewSupported } from "@/lib/gateway-url";
import { showTabLimitReachedToast } from "@/lib/tab-limit-toast";
import { getReviewAgent, type ReviewLaunchSelection } from "@/components/review/ReviewLaunchDialog";
import { type MultiReviewLaunchSelection } from "@/components/review/MultiReviewLaunchDialog";
import { type AgentLaunchSelection } from "@/components/launch/AgentLaunchDialog";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { useLongPressAction } from "@/hooks/useLongPressAction";
import { promptQueueKey } from "@/lib/prompt-queue-persistence";
import { createSessionKey } from "@/lib/utils";
import { createUuid } from "@/lib/uuid";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { findActiveMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { toast } from "sonner";
import type { ResolveLaunchResult } from "./ActionBar.types";

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return !!target.closest("input, textarea, select, [contenteditable='true'], .xterm");
}

export interface ActionBarControllerInput {
  presentation: "bar" | "grid";
}

export function useActionBarController({ presentation }: ActionBarControllerInput) {
  const dockerAvailable = useDockerAvailability();
  const isGrid = presentation === "grid";
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const projectBoardTab = useUIStore((state) => state.projectBoardTab);
  const setProjectBoardTab = useUIStore((state) => state.setProjectBoardTab);
  const setProjectBoardNotesOpen = useUIStore((state) => state.setProjectBoardNotesOpen);
  const updateEnvironment = useEnvironmentStore((state) => state.updateEnvironment);
  const selectedEnvironment = useEnvironmentStore((state) =>
    selectedEnvironmentId
      ? state.environments.find((environment) => environment.id === selectedEnvironmentId)
      : undefined,
  );
  const workspaceReady = selectedEnvironment?.setupPhase === "ready";
  const setupRunning = selectedEnvironment?.setupPhase === "running";
  const getProjectById = useProjectStore((state) => state.getProjectById);
  const { updateProject } = useProjects();
  const config = useConfigStore((state) => state.config);
  const { createTab, selectTab, tabCount } = useTerminalContext();
  const filesPanelOpen = useFilesPanelStore((state) => state.isOpen);
  const toggleFilesPanel = useFilesPanelStore((state) => state.togglePanel);
  const changes = useFilesPanelStore((state) => state.changes);

  // Settings dialogs are pinned by id, not by snapshot: the store stays the
  // single source of truth, so a background update to the pinned entity is
  // reflected live and a deletion closes the dialog instead of leaving an
  // orphaned copy whose saves would silently no-op.
  const [repoSettingsProjectId, setRepoSettingsProjectId] = useState<string | null>(null);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [envSettingsEnvironmentId, setEnvSettingsEnvironmentId] = useState<string | null>(null);
  const [dockerStatsOpen, setDockerStatsOpen] = useState(false);
  const [isOpeningEditor, setIsOpeningEditor] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [runCommands, setRunCommands] = useState<string[] | null>(null);
  const [isLoadingRunCommands, setIsLoadingRunCommands] = useState(false);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [cleanupTarget, setCleanupTarget] = useState<{
    environmentId: string;
    environmentName: string;
    isMerged: boolean;
  } | null>(null);
  const [deletingEnvironmentId, setDeletingEnvironmentId] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergingEnvironmentId, setMergingEnvironmentId] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [resolveLaunchEnvironmentId, setResolveLaunchEnvironmentId] = useState<string | null>(null);
  const resolveLaunchEnvironmentIdRef = useRef<string | null>(null);
  const selectedEnvironmentIdRef = useRef(selectedEnvironmentId);
  selectedEnvironmentIdRef.current = selectedEnvironmentId;
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [loopedReviewDialogOpen, setLoopedReviewDialogOpen] = useState(false);
  const [multiReviewDialogOpen, setMultiReviewDialogOpen] = useState(false);
  const [multiReviewLaunchPending, setMultiReviewLaunchPending] = useState(false);
  const multiReviewLaunchInFlightRef = useRef(false);
  const [loopedReviewLaunchPending, setLoopedReviewLaunchPending] = useState(false);
  const loopedReviewLaunchInFlightRef = useRef(false);
  const [prDialogTarget, setPrDialogTarget] = useState<{
    environmentId: string;
    projectId: string;
    targetBranch: string;
  } | null>(null);
  const [prLaunchError, setPrLaunchError] = useState<string | null>(null);
  const prDialogOpen = prDialogTarget !== null;
  const createPrButtonRef = useRef<HTMLButtonElement>(null);
  const [resolveDialogTarget, setResolveDialogTarget] = useState<{
    environmentId: string;
    projectId: string;
    targetBranch: string;
  } | null>(null);
  const [resolveLaunchError, setResolveLaunchError] = useState<string | null>(null);
  const resolveDialogOpen = resolveDialogTarget !== null;
  const resolveButtonRef = useRef<HTMLButtonElement>(null);

  const anyLaunchDialogOpen =
    reviewDialogOpen ||
    loopedReviewDialogOpen ||
    multiReviewDialogOpen ||
    prDialogOpen ||
    resolveDialogOpen;
  const reviewModelCatalog = useReviewModelCatalog(selectedProjectId ?? "", anyLaunchDialogOpen);
  // Drag-to-scroll state for toolbar
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  const selectedProject = selectedProjectId ? getProjectById(selectedProjectId) : null;
  const repoSettingsProject = useProjectStore((state) =>
    repoSettingsProjectId
      ? (state.projects.find((project) => project.id === repoSettingsProjectId) ?? null)
      : null,
  );
  const envSettingsEnvironment = useEnvironmentStore((state) =>
    envSettingsEnvironmentId
      ? (state.environments.find((environment) => environment.id === envSettingsEnvironmentId) ??
        null)
      : null,
  );
  // The pinned entity disappeared (deleted, or the project list was replaced).
  // Drop the pin too, so a later entity that happens to reuse the id cannot
  // resurrect a dialog the user never reopened.
  useEffect(() => {
    if (repoSettingsProjectId && !repoSettingsProject) setRepoSettingsProjectId(null);
  }, [repoSettingsProject, repoSettingsProjectId]);
  useEffect(() => {
    if (envSettingsEnvironmentId && !envSettingsEnvironment) {
      setEnvSettingsEnvironmentId(null);
    }
  }, [envSettingsEnvironment, envSettingsEnvironmentId]);
  const isProjectBoardView = !!selectedProject && !selectedEnvironment;
  const isCleanupTargetDeleting = Boolean(
    cleanupTarget &&
    (deletingEnvironmentId === cleanupTarget.environmentId ||
      (selectedEnvironmentId === cleanupTarget.environmentId &&
        !selectedEnvironment?.cleanupAfterMergeError &&
        (selectedEnvironment?.lifecycleOperation === "deleting" ||
          selectedEnvironment?.deletionRequestedAt))),
  );
  const isMerging = Boolean(
    selectedEnvironmentId &&
    (mergingEnvironmentId === selectedEnvironmentId ||
      selectedEnvironment?.lifecycleOperation === "merging"),
  );

  const repoName = selectedProject?.name ?? null;
  const isLocalEnvironment = selectedEnvironment?.environmentType === "local";
  const isLocalReady = isLocalEnvironment && !!selectedEnvironment?.worktreePath;
  const isRunning =
    isLocalReady ||
    (dockerAvailable && !isLocalEnvironment && selectedEnvironment?.status === "running");

  useEffect(() => {
    if (!dockerAvailable) setDockerStatsOpen(false);
  }, [dockerAvailable]);

  const {
    prUrl,
    prState,
    hasMergeConflicts,
    viewPR,
    setModeCreatePending,
    armRefreshAfterAgentCompletion,
    disarmRefreshAfterAgentCompletion,
  } = usePullRequest({ environmentId: selectedEnvironmentId });

  const { deleteEnvironment } = useEnvironments(selectedProjectId, {
    listenForRenameEvents: false,
  });

  const hasPR = !!prUrl;
  const isPRMerged = prState === "merged";
  const cleanupTargetIsMerged = cleanupTarget?.isMerged ?? isPRMerged;
  const isPRClosed = prState === "closed";
  const isPRFinished = isPRMerged || isPRClosed;
  const isSelectedEnvironmentDeleting = Boolean(
    selectedEnvironment &&
    !selectedEnvironment.cleanupAfterMergeError &&
    (selectedEnvironment.lifecycleOperation === "deleting" ||
      selectedEnvironment.deletionRequestedAt),
  );
  const canCreateTab = !!createTab && tabCount < MAX_TABS;
  // For containers, we need containerId; for local environments, we need worktreePath
  const canOpenEditor =
    isRunning &&
    ((isLocalEnvironment && !!selectedEnvironment?.worktreePath) ||
      (!isLocalEnvironment && !!selectedEnvironment?.containerId));
  const environmentPortAddress = getEnvironmentPortAddress(selectedEnvironment);
  const environmentBrowserUrl = getEnvironmentBrowserUrl(selectedEnvironment);
  const browserPreviewSupported = isGatewayBrowserPreviewSupported();
  const canCopyEnvironmentUrl = !!environmentPortAddress;

  // The object test only narrows the type: no environment means no
  // cleanupAfterMergeError, so `!error` already covers that case. Depending on
  // the whole environment would re-open a dismissed dialog on any field change.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const error = selectedEnvironment?.cleanupAfterMergeError;
    if (!selectedEnvironment || !error) return;
    setCleanupTarget({
      environmentId: selectedEnvironment.id,
      environmentName: selectedEnvironment.name,
      isMerged: true,
    });
    setCleanupError(error);
    setCleanupDialogOpen(true);
  }, [
    selectedEnvironment?.cleanupAfterMergeError,
    selectedEnvironment?.id,
    selectedEnvironment?.name,
  ]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  // Handler for opening in editor
  const handleOpenInEditor = useCallback(async () => {
    // Extract values for type safety
    const worktreePath = selectedEnvironment?.worktreePath;
    const containerId = selectedEnvironment?.containerId;

    // For local environments, use worktreePath; for containers, use containerId
    if (isLocalEnvironment && !worktreePath) return;
    if (!isLocalEnvironment && !containerId) return;

    setIsOpeningEditor(true);
    setEditorError(null);
    try {
      const editor = config.global.preferredEditor || "vscode";
      if (isLocalEnvironment && worktreePath) {
        await backend.openLocalInEditor(worktreePath, editor);
      } else if (containerId) {
        await backend.openInEditor(containerId, editor);
      }
    } catch (err) {
      console.error("[ActionBar] Failed to open editor:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setEditorError(errorMessage);
    } finally {
      setIsOpeningEditor(false);
    }
  }, [
    selectedEnvironment?.containerId,
    selectedEnvironment?.worktreePath,
    isLocalEnvironment,
    config.global.preferredEditor,
  ]);

  const handleCopyEnvironmentUrl = useCallback(() => {
    if (!environmentPortAddress) return;

    navigator.clipboard
      .writeText(environmentPortAddress)
      .then(() => {
        toast.success("Copied URL", { description: environmentPortAddress });
      })
      .catch(() => {
        toast.error("Failed to copy URL");
      });
  }, [environmentPortAddress]);

  // Get the default agent - per-environment override takes precedence over global config
  const enabledAgentList = useMemo<DefaultAgent[]>(
    () => config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
    [config.global.enabledAgentPlatforms],
  );
  const enabledAgents = useMemo(() => new Set<DefaultAgent>(enabledAgentList), [enabledAgentList]);
  const configuredDefaultAgent: DefaultAgent = resolvedDefaultAgent(
    config,
    selectedEnvironment?.projectId,
    selectedEnvironment,
  );
  const defaultAgent: DefaultAgent = enabledAgents.has(configuredDefaultAgent)
    ? configuredDefaultAgent
    : (enabledAgents.values().next().value ?? "claude");
  /**
   * The configured default for a toolbar action launched with a plain click.
   *
   * Right-clicking opens a launch dialog whose selection is authoritative, so
   * an explicit `launchOptions` always wins over this. An agent chosen for this
   * specific environment is narrower than an application-level default and wins
   * over it too.
   */
  const settingsTiers = useMemo(
    () => agentSettingsTiers(config, selectedEnvironment?.projectId, selectedEnvironment),
    [config, selectedEnvironment],
  );
  const actionDefaultFor = useCallback(
    (key: ActionDefaultKey) => resolvedActionDefault(settingsTiers, key, enabledAgentList),
    [enabledAgentList, settingsTiers],
  );
  const { preferredModelsByPlatform, preferredEffortsByPlatform } = useMemo(() => {
    const models: Partial<Record<DefaultAgent, string>> = {};
    const efforts: Partial<Record<DefaultAgent, string>> = {};
    for (const platform of enabledAgentList) {
      const resolved = resolveAgentPlatformSettings(settingsTiers, platform);
      if (resolved.model) models[platform] = resolved.model;
      if (resolved.reasoningEffort) efforts[platform] = resolved.reasoningEffort;
    }
    return { preferredModelsByPlatform: models, preferredEffortsByPlatform: efforts };
  }, [enabledAgentList, settingsTiers]);
  /**
   * Settings action defaults as launch-dialog preferences.
   *
   * A plain click still uses `actionDefaultFor`, so an environment created with
   * Codex is not retargeted. The configure dialog is the place the user asked
   * to pick a run, and it must open on what Settings named for this action —
   * including its model — even when the environment's own agent is different.
   */
  const launchDialogDefaultsFor = useCallback(
    (key: ActionDefaultKey) => {
      // Deliberately not `actionDefaultFor`: that keeps a narrower tier's own
      // `defaultAgent` ahead of the action default, which is right for a click
      // and wrong for the dialog the user opened to choose a run.
      const actionDefault = resolveActionDefault(resolveActionDefaults(settingsTiers), key, {
        fallbackAgent: defaultAgent,
        enabledAgents: enabledAgentList,
      });
      return {
        defaultAgent: actionDefault.agent,
        // Each platform's own resolved model, so the dialog opens on what that
        // platform would actually run rather than on a model from another
        // platform's catalogue.
        preferredModels: {
          ...preferredModelsByPlatform,
          ...(actionDefault.model ? { [actionDefault.agent]: actionDefault.model } : {}),
        },
        preferredReasoningEfforts: {
          ...preferredEffortsByPlatform,
          ...(actionDefault.reasoningEffort
            ? { [actionDefault.agent]: actionDefault.reasoningEffort }
            : {}),
        },
      };
    },
    [
      defaultAgent,
      enabledAgentList,
      preferredEffortsByPlatform,
      preferredModelsByPlatform,
      settingsTiers,
    ],
  );
  const { installLoopedReviewWorkflow, removeLoopedReviewWorkflow } = useLoopedReviewStore(
    useShallow((state) => ({
      installLoopedReviewWorkflow: state.replaceWorkflow,
      removeLoopedReviewWorkflow: state.removeWorkflow,
    })),
  );

  // Handler for code review
  const handleReview = useCallback(
    (
      agentOverride?: AgentPlatform,
      launchOptions?: {
        agentLaunchMode?: AgentLaunchModeOverride;
        initialAgentModel?: string;
        initialReasoningEffort?: string;
      },
    ) => {
      if (!createTab || !selectedEnvironmentId || !selectedProjectId || !canCreateTab) return;

      const repoConfig = config.repositories[selectedProjectId];
      const targetBranch = repoConfig?.prBaseBranch || "main";
      const reviewPrompt = createReviewPrompt(targetBranch, config.global.reviewInstruction);

      // A plain click has no dialog to configure the run, so the Defaults tab is
      // what stands in for one. An explicit override — the dialog, or a caller
      // that already chose an agent — always wins.
      const actionDefault = actionDefaultFor("review");
      const agent = agentOverride || actionDefault.agent;
      // The configured default only carries its model and reasoning level while
      // the launch is still going to the platform it named.
      const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
      // Resolved before the tab is created so the tab's own model selector and
      // the first queued turn cannot disagree about what a plain click asked for.
      // Every follow-up turn in the tab reads the tab's model, not this queue
      // entry, so omitting it here would confine the default to one turn.
      const initialAgentModel = launchOptions?.initialAgentModel ?? defaultForAgent?.model;
      const initialReasoningEffort =
        launchOptions?.initialReasoningEffort ?? defaultForAgent?.reasoningEffort;
      const tabId = `tab-${createUuid()}`;
      const created = createTab(agent, {
        tabId,
        // Keep a renderer-owned fallback until the durable queue mutation
        // succeeds. If persistence fails, the native tab can still retry the
        // launch instead of becoming an empty, unrecoverable review tab.
        initialPrompt: reviewPrompt,
        displayTitle: "Review",
        isReviewTab: true,
        agentLaunchMode: "native",
        ...launchOptions,
        ...(initialAgentModel ? { initialAgentModel } : {}),
        ...(initialReasoningEffort ? { initialReasoningEffort } : {}),
      });
      if (!created) {
        toast.error("Could not open review", {
          description: "The environment is not ready or the maximum tab count was reached.",
        });
        return;
      }

      const requestId = `initial-prompt:${selectedEnvironmentId}:${tabId}`;
      const logicalSessionKey = createSessionKey(selectedEnvironmentId, tabId);
      // When neither the dialog nor a configured default named a model, the
      // queued turn falls back to the platform's globally configured one. The tab
      // is left to resolve that itself, which is why it is not passed above.
      const requestedModel = initialAgentModel ?? preferredModelsByPlatform[agent];
      const model = requestedModel === "default" ? undefined : requestedModel;
      const reasoningEffort = initialReasoningEffort ?? preferredEffortsByPlatform[agent];
      const queuedReview =
        agent === "claude"
          ? {
              id: requestId,
              requestId,
              text: reviewPrompt,
              attachments: [],
              model,
              effort: reasoningEffort ?? "high",
              planModeEnabled: false,
              fastModeEnabled: false,
            }
          : agent === "codex"
            ? {
                id: requestId,
                requestId,
                text: reviewPrompt,
                attachments: [],
                model,
                reasoningEffort: reasoningEffort ?? "high",
                mode: "build" as const,
                fastMode: false,
              }
            : {
                id: requestId,
                requestId,
                text: reviewPrompt,
                attachments: [],
                model,
                variant: reasoningEffort,
                mode: "build" as const,
              };

      // Do not await UI lifecycle work after this hand-off. The queue mutation is
      // durable and wakes the backend dispatcher, so unmounting this ActionBar or
      // switching environments cannot delay the review until the tab is opened.
      void backend
        .enqueuePromptQueueMessage(
          promptQueueKey(agent, logicalSessionKey),
          selectedEnvironmentId,
          queuedReview,
        )
        .then(() => {
          // Persistence is now authoritative. Remove the renderer fallback before
          // a later remount can mistake it for an undispatched launch. Both paths
          // use the same request id, so a mount racing this acknowledgement remains
          // provider-idempotent.
          usePaneLayoutStore.getState().clearTabInitialPrompt(tabId, selectedEnvironmentId);
        })
        .catch((error) => {
          toast.error("Could not start review", {
            description: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [
      actionDefaultFor,
      canCreateTab,
      preferredModelsByPlatform,
      preferredEffortsByPlatform,
      config.global.reviewInstruction,
      config.repositories,
      createTab,
      selectedEnvironmentId,
      selectedProjectId,
    ],
  );

  const openReviewDialog = useCallback(() => {
    if (!selectedEnvironment || !canCreateTab) return;
    setReviewDialogOpen(true);
  }, [canCreateTab, selectedEnvironment]);

  const reviewLongPress = useLongPressAction(
    openReviewDialog,
    Boolean(selectedEnvironment) && canCreateTab,
  );

  const handleConfiguredReview = useCallback(
    (selection: ReviewLaunchSelection) => {
      const agent = getReviewAgent(selection.tabType);
      handleReview(agent, {
        agentLaunchMode: "native",
        initialAgentModel: selection.model,
        initialReasoningEffort: selection.reasoningEffort,
      });
      setReviewDialogOpen(false);
    },
    [handleReview],
  );

  const handleMultiReview = useCallback(
    async (selection: MultiReviewLaunchSelection) => {
      if (
        multiReviewLaunchInFlightRef.current ||
        !createTab ||
        !selectedEnvironmentId ||
        !selectedProjectId ||
        !selectedEnvironment ||
        !canCreateTab ||
        !isRunning ||
        !workspaceReady ||
        setupRunning
      )
        return;
      multiReviewLaunchInFlightRef.current = true;
      setMultiReviewLaunchPending(true);
      let workflowId: string | undefined;
      let cancelRequested = false;
      try {
        // An environment may hold only one active Multi Review, and closing its
        // tab deliberately leaves the backend workflow running. Reattach to it
        // rather than failing the launch: the running one is otherwise
        // unreachable, and its Abandon control — the only way to free the
        // environment for a new review — lives inside the tab being reopened.
        const active = await findActiveMultiReviewWorkflow(selectedEnvironmentId);
        if (active) {
          if (
            !createTab("multi-review", {
              multiReviewId: active.id,
              displayTitle: "Multi Review",
            })
          ) {
            throw new Error(
              "A Multi Review is already running, but its tab could not be reopened." +
                " Close a tab and try again.",
            );
          }
          setMultiReviewDialogOpen(false);
          toast.info("Multi Review already running", {
            description:
              "Reopened the review already running in this environment." +
              " Cancel or abandon it there to start a new one.",
          });
          return;
        }
        const workflow = await backend.startMultiReview({
          environmentId: selectedEnvironmentId,
          projectId: selectedProjectId,
          targetBranch: config.repositories[selectedProjectId]?.prBaseBranch || "main",
          reviewInstruction: config.global.reviewInstruction,
          reviewers: selection.reviewers,
          fixModel: selection.fixModel,
        });
        workflowId = workflow.id;
        useMultiReviewStore.getState().replaceWorkflow(workflow);
        const created = createTab("multi-review", {
          multiReviewId: workflow.id,
          displayTitle: "Multi Review",
        });
        if (!created) {
          const launchError = "The environment is not ready or the maximum tab count was reached.";
          const cancelled = await backend.cancelMultiReview(workflow.id);
          cancelRequested = true;
          useMultiReviewStore.getState().replaceWorkflow(cancelled);
          // Cancellation is asynchronous, and only a terminal workflow may be
          // deleted. Deleting a still-cancelling one is rejected by the backend,
          // which would replace this message with a confusing storage error and
          // strand the record. Keep it installed for recovery instead.
          if (cancelled.phase !== "cancelled") {
            throw new Error(
              `${launchError} Cancellation is still in progress; the saved Multi Review remains available for recovery.`,
            );
          }
          await backend.deleteMultiReviewWorkflow(workflow.id);
          useMultiReviewStore.getState().removeWorkflow(workflow.id);
          throw new Error(launchError);
        }
        setMultiReviewDialogOpen(false);
      } catch (error) {
        toast.error("Could not open Multi Review", {
          description: error instanceof Error ? error.message : String(error),
        });
        if (workflowId && !cancelRequested) {
          void backend.cancelMultiReview(workflowId).catch(() => undefined);
        }
      } finally {
        multiReviewLaunchInFlightRef.current = false;
        setMultiReviewLaunchPending(false);
      }
    },
    [
      canCreateTab,
      config.global.reviewInstruction,
      config.repositories,
      createTab,
      isRunning,
      selectedEnvironment,
      selectedEnvironmentId,
      selectedProjectId,
      setupRunning,
      workspaceReady,
    ],
  );

  const handleLoopedReview = useCallback(
    async (selection: ReviewLaunchSelection) => {
      if (
        loopedReviewLaunchInFlightRef.current ||
        !createTab ||
        !selectedEnvironmentId ||
        !selectedProjectId ||
        !selectedEnvironment ||
        !canCreateTab ||
        !isRunning ||
        !workspaceReady ||
        setupRunning
      ) {
        return;
      }
      // React state does not update until this event returns. Keep a synchronous
      // guard as well so a double click/submit cannot start two backend workflows.
      loopedReviewLaunchInFlightRef.current = true;
      setLoopedReviewLaunchPending(true);
      let workflowId: string | undefined;
      let launchError: string | undefined;
      try {
        const { task } = findTaskForEnvironment(selectedEnvironmentId);
        const kanbanState = useKanbanStore.getState();
        const hasCurrentProjectNotes =
          kanbanState.currentNotesProjectId === selectedProjectId &&
          kanbanState.notes.trim().length > 0;
        const context =
          task || hasCurrentProjectNotes
            ? {
                ticketTitle: task?.title,
                ticketDescription: task?.description,
                acceptanceCriteria: task?.acceptanceCriteria,
                comments: task?.comments.map((comment) => comment.text),
                imageNames: task?.images.map((image) => image.filename),
                projectNotes: hasCurrentProjectNotes ? kanbanState.notes : undefined,
              }
            : undefined;
        const workflow = await backend.startLoopedReview({
          environmentId: selectedEnvironmentId,
          projectId: selectedProjectId,
          agent: getReviewAgent(selection.tabType),
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
          targetBranch: config.repositories[selectedProjectId]?.prBaseBranch || "main",
          reviewInstruction: config.global.reviewInstruction,
          context,
          allowance: selection.passAllowance,
        });
        workflowId = workflow.id;
        installLoopedReviewWorkflow(workflow);
        const created = createTab("looped-review", {
          loopedReviewId: workflowId,
          displayTitle: "Looped Review",
        });
        if (!created) {
          launchError = "The environment is not ready or the maximum tab count was reached.";
        }
      } catch (error) {
        launchError = error instanceof Error ? error.message : String(error);
      }

      try {
        if (!launchError) {
          setLoopedReviewDialogOpen(false);
          return;
        }

        if (!workflowId) {
          toast.error("Could not open looped review", { description: launchError });
          return;
        }

        const reportPreservedWorkflow = (description: string) => {
          toast.error("Could not open looped review", {
            description,
            action: {
              label: "Open workflow",
              onClick: () => {
                try {
                  const opened = createTab("looped-review", {
                    loopedReviewId: workflowId,
                    displayTitle: "Looped Review",
                  });
                  if (!opened) {
                    toast.error("Could not restore looped review", {
                      description: "Free a tab and try opening the saved workflow again.",
                    });
                  }
                } catch (error) {
                  toast.error("Could not restore looped review", {
                    description: error instanceof Error ? error.message : String(error),
                  });
                }
              },
            },
          });
        };

        // Keep the authoritative snapshot installed until both cancellation and
        // deletion are confirmed. If either operation fails, the workflow stays
        // available for hydration/recovery instead of becoming invisible while
        // its provider may still be running.
        try {
          const cancelledWorkflow = await backend.cancelLoopedReview(workflowId);
          installLoopedReviewWorkflow(cancelledWorkflow);
          if (cancelledWorkflow.phase === "cancelled") {
            await backend.deleteLoopedReviewWorkflow(workflowId);
            removeLoopedReviewWorkflow(workflowId);
            toast.error("Could not open looped review", { description: launchError });
            return;
          }

          reportPreservedWorkflow(
            `${launchError} Cancellation is still in progress; the saved workflow remains available for recovery.`,
          );
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          reportPreservedWorkflow(
            `${launchError} Cleanup failed: ${cleanupMessage}. The saved workflow remains available for recovery.`,
          );
        }
      } finally {
        loopedReviewLaunchInFlightRef.current = false;
        setLoopedReviewLaunchPending(false);
      }
    },
    [
      canCreateTab,
      config.global.reviewInstruction,
      config.repositories,
      createTab,
      installLoopedReviewWorkflow,
      isRunning,
      removeLoopedReviewWorkflow,
      selectedEnvironment,
      selectedEnvironmentId,
      selectedProjectId,
      setupRunning,
      workspaceReady,
    ],
  );

  // Load run commands from orkestrator-ai.json when workspace is ready
  useEffect(() => {
    // Extract values for type safety
    const worktreePath = selectedEnvironment?.worktreePath;
    const containerId = selectedEnvironment?.containerId;

    // For container environments, we need containerId
    // For local environments, we need worktreePath
    const hasContainer = !isLocalEnvironment && !!containerId;
    const hasWorktree = isLocalEnvironment && !!worktreePath;

    if ((!hasContainer && !hasWorktree) || !isRunning || !workspaceReady) {
      setRunCommands(null);
      return;
    }

    let cancelled = false;
    setIsLoadingRunCommands(true);

    const readConfigPromise =
      isLocalEnvironment && worktreePath
        ? backend.readLocalFile(worktreePath, "orkestrator-ai.json")
        : containerId
          ? backend.readContainerFile(containerId, "orkestrator-ai.json")
          : null;

    if (!readConfigPromise) {
      setIsLoadingRunCommands(false);
      return;
    }

    readConfigPromise
      .then((result) => {
        if (cancelled) return;
        try {
          const config = JSON.parse(result.content) as { run?: unknown };
          const commands = Array.isArray(config.run)
            ? config.run.filter(
                (command): command is string =>
                  typeof command === "string" && command.trim().length > 0,
              )
            : [];
          if (commands.length > 0) {
            setRunCommands(commands);
          } else {
            setRunCommands(null);
          }
        } catch {
          setRunCommands(null);
        }
      })
      .catch((error) => {
        console.error("[ActionBar] Failed to read orkestrator-ai.json:", error);
        if (!cancelled) {
          setRunCommands(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRunCommands(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedEnvironment?.containerId,
    selectedEnvironment?.worktreePath,
    isLocalEnvironment,
    isRunning,
    workspaceReady,
  ]);

  // Handler for run commands
  const handleRun = useCallback(() => {
    if (!createTab || !canCreateTab || !runCommands || runCommands.length === 0) return;

    createTab("plain", { initialCommands: runCommands });
  }, [createTab, canCreateTab, runCommands]);

  const handleCreateScript = useCallback(
    (agentOverride?: DefaultAgent) => {
      if (!createTab || !canCreateTab || !isRunning) return;

      const initialPrompt = createOrkestratorScriptPrompt(isLocalEnvironment);
      createTab(agentOverride || defaultAgent, { initialPrompt });
    },
    [createTab, canCreateTab, isRunning, isLocalEnvironment, defaultAgent],
  );

  const handleCreateAgentTab = useCallback(
    (agent: DefaultAgent, agentLaunchMode?: AgentLaunchModeOverride) => {
      if (!createTab || !canCreateTab) return;

      createTab(agent, agentLaunchMode ? { agentLaunchMode } : undefined);
    },
    [createTab, canCreateTab],
  );

  const handleCreateNativeTab = useCallback(() => {
    if (!createTab || !canCreateTab) return;
    createTab("agent-native");
  }, [canCreateTab, createTab]);

  const handleCreateBrowserTab = useCallback(() => {
    if (!createTab || !canCreateTab) return;
    createTab("browser", { initialUrl: environmentBrowserUrl ?? undefined });
  }, [canCreateTab, createTab, environmentBrowserUrl]);

  const hasRunCommands = runCommands && runCommands.length > 0;
  const canRunCommands = canCreateTab && !isLoadingRunCommands && !!hasRunCommands && !setupRunning;

  const handleRunButtonClick = useCallback(() => {
    if (!canRunCommands) {
      return;
    }
    handleRun();
  }, [canRunCommands, handleRun]);

  // Drag-to-scroll handlers for toolbar
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setIsDragging(true);
    setStartX(e.pageX - container.offsetLeft);
    setScrollLeft(container.scrollLeft);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const container = scrollContainerRef.current;
      if (!container) return;

      e.preventDefault();
      const x = e.pageX - container.offsetLeft;
      const walk = (x - startX) * 1.5; // Multiplier for scroll speed
      container.scrollLeft = scrollLeft - walk;
    },
    [isDragging, startX, scrollLeft],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const suppressNativeContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      // Keep custom Radix menus enabled for explicitly marked triggers.
      if (target.closest("[data-toolbar-custom-context-menu='true']")) {
        return;
      }

      event.preventDefault();
    };

    container.addEventListener("contextmenu", suppressNativeContextMenu, true);

    return () => {
      container.removeEventListener("contextmenu", suppressNativeContextMenu, true);
    };
  }, []);

  // Keyboard shortcuts for terminal tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Handle Ctrl+number for tab selection (1-9) - works on all platforms
      // Using Ctrl specifically to avoid conflicts with ⌘+number on Mac (used for other OS shortcuts)
      // Note: selectTab internally bounds-checks against the active pane's tab count
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        // Use e.code (physical key) as primary since e.key can vary with keyboard layouts
        // e.code is "Digit1", "Digit2", etc. for number keys
        let num = NaN;
        if (e.code?.startsWith("Digit")) {
          num = parseInt(e.code.slice(5), 10);
        } else {
          // Fallback to e.key for compatibility
          num = parseInt(e.key, 10);
        }

        if (num >= 1 && num <= 9 && selectTab) {
          e.preventDefault();
          selectTab(num - 1); // Convert to 0-based index
          return;
        }
      }

      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") {
        if (canCopyEnvironmentUrl) {
          if (isEditableShortcutTarget(e.target)) {
            return;
          }
          e.preventDefault();
          handleCopyEnvironmentUrl();
        }
        return;
      }

      // ⌘ shortcuts on Mac only to avoid conflicts
      // (Ctrl+T/N/O are commonly used by browsers and other apps on Windows/Linux)
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

      const reportTabLimit = () => {
        if (tabCount < MAX_TABS || !createTab || !selectedEnvironment) return false;
        e.preventDefault();
        showTabLimitReachedToast(MAX_TABS);
        return true;
      };

      switch (e.key.toLowerCase()) {
        case "t":
          if (reportTabLimit()) break;
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("plain");
          }
          break;
        case "n":
          if (reportTabLimit()) break;
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("agent-native");
          }
          break;
        case "r":
          if (selectedProjectId && reportTabLimit()) break;
          if (canCreateTab && selectedProjectId) {
            e.preventDefault();
            handleReview();
          }
          break;
        case "p":
          if (hasRunCommands && reportTabLimit()) break;
          if (canRunCommands) {
            e.preventDefault();
            handleRun();
          }
          break;
        case "o":
          if (canOpenEditor) {
            e.preventDefault();
            handleOpenInEditor();
          }
          break;
        case "e":
          // Toggle files panel
          if (selectedEnvironment) {
            e.preventDefault();
            toggleFilesPanel();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    createTab,
    selectTab,
    tabCount,
    canCreateTab,
    canOpenEditor,
    handleOpenInEditor,
    canCopyEnvironmentUrl,
    handleCopyEnvironmentUrl,
    selectedEnvironment,
    selectedProjectId,
    handleReview,
    hasRunCommands,
    canRunCommands,
    handleRun,
    toggleFilesPanel,
    enabledAgents,
  ]);

  // Handler for PR creation - launches agent tab with PR workflow prompt
  const handleCreatePR = useCallback(
    (
      agentOverride?: AgentPlatform,
      launchOptions?: {
        agentLaunchMode?: AgentLaunchModeOverride;
        initialAgentModel?: string;
        initialReasoningEffort?: string;
      },
      targetBranchOverride?: string,
    ): boolean => {
      if (
        !createTab ||
        !selectedEnvironmentId ||
        !selectedProjectId ||
        !canCreateTab ||
        !isRunning ||
        hasPR
      )
        return false;

      const repoConfig = config.repositories[selectedProjectId];
      // Falsy, not nullish: repository settings persist a cleared PR base branch
      // as "", and an empty base would reach the agent as `gh pr create --base `.
      const targetBranch = targetBranchOverride || repoConfig?.prBaseBranch || "main";
      const prPrompt = createPRPrompt(targetBranch);
      const actionDefault = actionDefaultFor("pr");
      const agent = agentOverride || actionDefault.agent;
      const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
      // Resolved once so the queued path and the tab-owned path cannot disagree
      // about which model a plain click asked for.
      const initialAgentModel = launchOptions?.initialAgentModel ?? defaultForAgent?.model;
      const initialReasoningEffort =
        launchOptions?.initialReasoningEffort ?? defaultForAgent?.reasoningEffort;
      // ACP tabs are always native unless explicitly opened as a CLI. The
      // configured workflow likewise forces every provider through its native
      // surface. Give those launches a stable identity before the tab mounts so
      // the backend queue can own the turn immediately.
      const backendOwnsPrompt =
        launchOptions?.agentLaunchMode === "native" ||
        ((agent === "cursor" || agent === "grok") && launchOptions?.agentLaunchMode !== "cli");
      const tabId = backendOwnsPrompt ? `tab-${createUuid()}` : undefined;

      const created = createTab(agent, {
        ...(tabId ? { tabId } : {}),
        initialPrompt: prPrompt,
        displayTitle: "PR",
        ...launchOptions,
        ...(initialAgentModel ? { initialAgentModel } : {}),
        ...(initialReasoningEffort ? { initialReasoningEffort } : {}),
      });
      if (!created) return false;

      if (tabId) {
        const requestId = `initial-prompt:${selectedEnvironmentId}:${tabId}`;
        const model = initialAgentModel === "default" ? undefined : initialAgentModel;
        const reasoningEffort = initialReasoningEffort;
        const queuedPrompt = {
          id: requestId,
          requestId,
          text: prPrompt,
          attachments: [],
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          mode: "build" as const,
          // Stated rather than omitted: speed is a per-session model-picker
          // choice, and saying "normal" explicitly keeps this path identical to
          // the review queue instead of relying on each provider's own default.
          ...(agent === "claude" || agent === "codex" ? { fastMode: false } : {}),
        };
        const logicalSessionKey = createSessionKey(selectedEnvironmentId, tabId);

        // The durable queue wakes the backend dispatcher independently of the
        // active environment. Keep the tab's initial prompt as an idempotent
        // renderer fallback until persistence succeeds.
        void backend
          .enqueuePromptQueueMessage(
            promptQueueKey(agent, logicalSessionKey),
            selectedEnvironmentId,
            queuedPrompt,
          )
          .then(() => {
            usePaneLayoutStore.getState().clearTabInitialPrompt(tabId, selectedEnvironmentId);
          })
          .catch((error) => {
            toast.error("Could not start pull request creation", {
              description: error instanceof Error ? error.message : String(error),
            });
          });
      }

      // Set monitoring mode only after the tab exists. Otherwise a rejected
      // launch leaves the backend polling for a PR no agent is creating.
      setModeCreatePending();
      return true;
    },
    [
      actionDefaultFor,
      canCreateTab,
      config.repositories,
      createTab,
      hasPR,
      isRunning,
      selectedEnvironmentId,
      selectedProjectId,
      setModeCreatePending,
    ],
  );

  const canConfigurePR = Boolean(
    canCreateTab && isRunning && !hasPR && selectedEnvironmentId && selectedProjectId,
  );

  const openPrDialog = useCallback(() => {
    if (!canConfigurePR || !selectedEnvironmentId || !selectedProjectId) return;
    setPrLaunchError(null);
    setPrDialogTarget({
      environmentId: selectedEnvironmentId,
      projectId: selectedProjectId,
      targetBranch: config.repositories[selectedProjectId]?.prBaseBranch || "main",
    });
  }, [canConfigurePR, config.repositories, selectedEnvironmentId, selectedProjectId]);

  const prLongPress = useLongPressAction(openPrDialog, canConfigurePR);

  const prEligibilityError = !prDialogTarget
    ? null
    : selectedEnvironmentId !== prDialogTarget.environmentId ||
        selectedProjectId !== prDialogTarget.projectId
      ? "The selected environment changed. Close this dialog and reopen it from the intended environment."
      : hasPR
        ? "A pull request now exists for this environment."
        : !isRunning
          ? "The environment is no longer running."
          : // `canCreateTab` folds two distinct causes together, so report them
            // separately: an unregistered `createTab` means the environment's
            // terminal is not ready, which the tab limit wording would misdescribe.
            tabCount >= MAX_TABS
            ? "The maximum number of tabs has been reached."
            : !canCreateTab
              ? "This environment is not ready to open a new tab yet."
              : null;

  const handleConfiguredCreatePR = useCallback(
    (selection: AgentLaunchSelection) => {
      if (!prDialogTarget || prEligibilityError) return;
      const created = handleCreatePR(
        selection.agent,
        {
          agentLaunchMode: "native",
          initialAgentModel: selection.model,
          initialReasoningEffort: selection.reasoningEffort,
        },
        prDialogTarget.targetBranch,
      );
      if (!created) {
        setPrLaunchError(
          "The pull request agent tab could not be created. Check the environment and tab limit, then try again.",
        );
        return;
      }
      setPrLaunchError(null);
      setPrDialogTarget(null);
    },
    [handleCreatePR, prDialogTarget, prEligibilityError],
  );

  // Handler for pushing changes to an existing PR - launches agent tab with commit/push prompt
  const handlePushChanges = useCallback(
    (agentOverride?: AgentPlatform) => {
      if (!createTab || !canCreateTab) return;

      const pushPrompt = createPushChangesPrompt();
      // The context menu picks an agent only, so its choice keeps the configured
      // model and reasoning level only while it stays on the same platform.
      const actionDefault = actionDefaultFor("push");
      const agent = agentOverride || actionDefault.agent;
      const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
      createTab(agent, {
        initialPrompt: pushPrompt,
        displayTitle: "Git Push",
        ...(defaultForAgent?.model ? { initialAgentModel: defaultForAgent.model } : {}),
        ...(defaultForAgent?.reasoningEffort
          ? { initialReasoningEffort: defaultForAgent.reasoningEffort }
          : {}),
      });
    },
    [actionDefaultFor, createTab, canCreateTab],
  );

  // Handler for resolving merge conflicts - launches agent tab with conflict resolution prompt
  const handleResolveConflicts = useCallback(
    async (options?: {
      agent?: AgentPlatform;
      launch?: {
        agentLaunchMode?: AgentLaunchModeOverride;
        initialAgentModel?: string;
        initialReasoningEffort?: string;
      };
      targetBranch?: string;
      /**
       * Where a failure is reported. The configured launch renders the message
       * inside its own dialog, so a toast there would report the same failure
       * twice, in two different wordings.
       */
      reportFailure?: "toast" | "return";
    }): Promise<ResolveLaunchResult> => {
      const {
        agent: agentOverride,
        launch: launchOptions,
        targetBranch: targetBranchOverride,
        reportFailure = "toast",
      } = options ?? {};
      const operationEnvironmentId = selectedEnvironmentId;
      if (
        !createTab ||
        !operationEnvironmentId ||
        !selectedProjectId ||
        !canCreateTab ||
        resolveLaunchEnvironmentIdRef.current !== null
      )
        return { ok: false, message: null };

      resolveLaunchEnvironmentIdRef.current = operationEnvironmentId;
      setResolveLaunchEnvironmentId(operationEnvironmentId);

      const repoConfig = config.repositories[selectedProjectId];
      const targetBranch = targetBranchOverride || repoConfig?.prBaseBranch || "main";
      const resolvePrompt = createResolveConflictsPrompt(targetBranch);
      let armedAt: string | null = null;

      const rollBackArm = async () => {
        if (!armedAt) return;
        try {
          await disarmRefreshAfterAgentCompletion(armedAt);
        } catch (error) {
          console.warn("[ActionBar] Failed to roll back the PR refresh arm:", error);
        }
      };

      const fail = async (message: string): Promise<ResolveLaunchResult> => {
        await rollBackArm();
        if (reportFailure === "toast") {
          toast.error("Could not open conflict resolution", { description: message });
        }
        return { ok: false, message };
      };

      try {
        // The backend stores this intent before the turn can be dispatched, so
        // inactive environments and renderer reloads cannot lose the refresh.
        armedAt = await armRefreshAfterAgentCompletion();
      } catch (error) {
        console.warn("[ActionBar] Failed to arm PR refresh after conflict resolution:", error);
        // Always a toast: the launch still proceeds and the dialog closes behind
        // it, so there is no surface left to carry a degraded-refresh warning.
        toast.error("Could not schedule the PR refresh", {
          description:
            "Conflict resolution will still open, but PR status may need a manual refresh.",
        });
      }

      try {
        if (selectedEnvironmentIdRef.current !== operationEnvironmentId) {
          return await fail("The selected environment changed before the agent could launch.");
        }

        const actionDefault = actionDefaultFor("resolve");
        const agent = agentOverride || actionDefault.agent;
        const defaultForAgent = agent === actionDefault.agent ? actionDefault : undefined;
        // Same precedence as every other action: the dialog's selection first,
        // then the configured default, resolved once rather than by spread order.
        const initialAgentModel = launchOptions?.initialAgentModel ?? defaultForAgent?.model;
        const initialReasoningEffort =
          launchOptions?.initialReasoningEffort ?? defaultForAgent?.reasoningEffort;
        const created = createTab(agent, {
          initialPrompt: resolvePrompt,
          displayTitle: "Resolve",
          ...launchOptions,
          ...(initialAgentModel ? { initialAgentModel } : {}),
          ...(initialReasoningEffort ? { initialReasoningEffort } : {}),
        });
        if (!created) {
          return await fail(
            "The environment may no longer be ready or the maximum tab count was reached.",
          );
        }
        return { ok: true };
      } catch (error) {
        return await fail(error instanceof Error ? error.message : String(error));
      } finally {
        if (resolveLaunchEnvironmentIdRef.current === operationEnvironmentId) {
          resolveLaunchEnvironmentIdRef.current = null;
          setResolveLaunchEnvironmentId(null);
        }
      }
    },
    [
      actionDefaultFor,
      armRefreshAfterAgentCompletion,
      disarmRefreshAfterAgentCompletion,
      createTab,
      selectedEnvironmentId,
      selectedProjectId,
      canCreateTab,
      config.repositories,
    ],
  );

  const resolveLaunchInFlight = resolveLaunchEnvironmentId !== null;

  const canConfigureResolve = Boolean(
    canCreateTab &&
    isRunning &&
    hasPR &&
    !isPRFinished &&
    hasMergeConflicts &&
    selectedEnvironmentId &&
    selectedProjectId &&
    !resolveLaunchInFlight,
  );

  const openResolveDialog = useCallback(() => {
    if (!canConfigureResolve || !selectedEnvironmentId || !selectedProjectId) return;
    setResolveLaunchError(null);
    setResolveDialogTarget({
      environmentId: selectedEnvironmentId,
      projectId: selectedProjectId,
      targetBranch: config.repositories[selectedProjectId]?.prBaseBranch || "main",
    });
  }, [canConfigureResolve, config.repositories, selectedEnvironmentId, selectedProjectId]);

  const resolveLongPress = useLongPressAction(openResolveDialog, canConfigureResolve);

  // A launch already in flight is deliberately absent: it is progress, not an
  // eligibility fault, and is reported through the dialog's busy state instead.
  const resolveEligibilityError = !resolveDialogTarget
    ? null
    : selectedEnvironmentId !== resolveDialogTarget.environmentId ||
        selectedProjectId !== resolveDialogTarget.projectId
      ? "The selected environment changed. Close this dialog and reopen it from the intended environment."
      : !hasPR || isPRFinished || !hasMergeConflicts
        ? "This pull request no longer has merge conflicts to resolve."
        : !isRunning
          ? "The environment is no longer running."
          : tabCount >= MAX_TABS
            ? "The maximum number of tabs has been reached."
            : !canCreateTab
              ? "This environment is not ready to open a new tab yet."
              : null;

  const handleConfiguredResolve = useCallback(
    async (selection: AgentLaunchSelection) => {
      if (!resolveDialogTarget || resolveEligibilityError || resolveLaunchInFlight) return;
      setResolveLaunchError(null);
      const result = await handleResolveConflicts({
        agent: selection.agent,
        launch: {
          agentLaunchMode: "native",
          initialAgentModel: selection.model,
          initialReasoningEffort: selection.reasoningEffort,
        },
        targetBranch: resolveDialogTarget.targetBranch,
        // The dialog stays open on failure and owns the message, so the toast
        // would be a second, less specific copy of the same report.
        reportFailure: "return",
      });
      if (result.ok) {
        setResolveDialogTarget(null);
        return;
      }
      if (result.message) setResolveLaunchError(result.message);
    },
    [handleResolveConflicts, resolveDialogTarget, resolveEligibilityError, resolveLaunchInFlight],
  );

  // Handler for cleaning up (deleting) an environment after PR is merged/closed
  const handleCleanup = useCallback(async () => {
    const operationEnvironmentId = cleanupTarget?.environmentId ?? selectedEnvironmentId;
    if (!operationEnvironmentId || deletingEnvironmentId === operationEnvironmentId) return;

    setDeletingEnvironmentId(operationEnvironmentId);
    setCleanupError(null);
    try {
      await deleteEnvironment(operationEnvironmentId);
      setCleanupDialogOpen(false);
      setCleanupTarget(null);
    } catch (err) {
      console.error("[ActionBar] Failed to delete environment:", err);
      const message = err instanceof Error ? err.message : "An unexpected error occurred";
      setCleanupError(message);
    } finally {
      setDeletingEnvironmentId((current) => (current === operationEnvironmentId ? null : current));
    }
  }, [
    cleanupTarget?.environmentId,
    deletingEnvironmentId,
    selectedEnvironmentId,
    deleteEnvironment,
  ]);

  // Handler for merging a PR, optionally deleting its environment after GitHub
  // confirms that the merge completed.
  const handleMergePR = useCallback(
    async (cleanupAfterMerge: boolean) => {
      if (!selectedEnvironmentId || !prUrl) return;

      // Close dialog immediately and show spinner on main button
      setMergeDialogOpen(false);
      const operationEnvironmentId = selectedEnvironmentId;
      const operationEnvironmentName = selectedEnvironment?.name ?? selectedEnvironmentId;
      const operationBranch = selectedEnvironment?.branch ?? "current branch";
      setMergingEnvironmentId(operationEnvironmentId);
      setMergeError(null);

      try {
        console.log("[ActionBar] Starting PR merge...");
        const mergeResult = await backend.mergeEnvironmentPr(
          operationEnvironmentId,
          "squash",
          true,
          cleanupAfterMerge,
        );
        console.log("[ActionBar] Merge command completed successfully");

        if (mergeResult.outcome !== "merged") {
          toast.success(mergeResult.outcome === "pending" ? "Merge pending" : "Merge submitted", {
            description: operationBranch,
            id: `branch-merge-submitted-${operationEnvironmentId}`,
          });
          return;
        }

        toast.success("Branch merged", {
          description: operationBranch,
          id: `branch-merged-${operationEnvironmentId}`,
        });

        if (mergeResult.cleanupOutcome === "failed") {
          setCleanupError(mergeResult.cleanupError ?? "An unexpected error occurred");
          setCleanupTarget({
            environmentId: operationEnvironmentId,
            environmentName: operationEnvironmentName,
            isMerged: true,
          });
          setCleanupDialogOpen(true);
        }
      } catch (err) {
        console.error("[ActionBar] Failed to merge PR:", err);
        // backend invoke errors come as strings, not Error objects
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "An unexpected error occurred";
        setMergeError(message);
        setMergeDialogOpen(true); // Re-open dialog to show error
      } finally {
        setMergingEnvironmentId((current) => (current === operationEnvironmentId ? null : current));
      }
    },
    [selectedEnvironment?.branch, selectedEnvironment?.name, selectedEnvironmentId, prUrl],
  );

  // Get target branch for PR dialog
  const targetBranch = selectedProjectId
    ? config.repositories[selectedProjectId]?.prBaseBranch || "main"
    : "main";
  const sourceBranch = selectedEnvironment?.branch || "current branch";

  return {
    dockerAvailable,
    isGrid,
    selectedEnvironmentId,
    selectedProjectId,
    projectBoardTab,
    setProjectBoardTab,
    setProjectBoardNotesOpen,
    updateEnvironment,
    selectedEnvironment,
    workspaceReady,
    setupRunning,
    getProjectById,
    updateProject,
    config,
    createTab,
    selectTab,
    tabCount,
    filesPanelOpen,
    toggleFilesPanel,
    changes,
    repoSettingsProjectId,
    setRepoSettingsProjectId,
    globalSettingsOpen,
    setGlobalSettingsOpen,
    envSettingsEnvironmentId,
    setEnvSettingsEnvironmentId,
    dockerStatsOpen,
    setDockerStatsOpen,
    isOpeningEditor,
    setIsOpeningEditor,
    editorError,
    setEditorError,
    runCommands,
    setRunCommands,
    isLoadingRunCommands,
    setIsLoadingRunCommands,
    cleanupDialogOpen,
    setCleanupDialogOpen,
    cleanupTarget,
    setCleanupTarget,
    deletingEnvironmentId,
    setDeletingEnvironmentId,
    cleanupError,
    setCleanupError,
    mergeDialogOpen,
    setMergeDialogOpen,
    mergingEnvironmentId,
    setMergingEnvironmentId,
    mergeError,
    setMergeError,
    resolveLaunchEnvironmentId,
    setResolveLaunchEnvironmentId,
    resolveLaunchEnvironmentIdRef,
    selectedEnvironmentIdRef,
    reviewDialogOpen,
    setReviewDialogOpen,
    loopedReviewDialogOpen,
    setLoopedReviewDialogOpen,
    multiReviewDialogOpen,
    setMultiReviewDialogOpen,
    multiReviewLaunchPending,
    setMultiReviewLaunchPending,
    multiReviewLaunchInFlightRef,
    loopedReviewLaunchPending,
    setLoopedReviewLaunchPending,
    loopedReviewLaunchInFlightRef,
    prDialogTarget,
    setPrDialogTarget,
    prLaunchError,
    setPrLaunchError,
    prDialogOpen,
    createPrButtonRef,
    resolveDialogTarget,
    setResolveDialogTarget,
    resolveLaunchError,
    setResolveLaunchError,
    resolveDialogOpen,
    resolveButtonRef,
    anyLaunchDialogOpen,
    reviewModelCatalog,
    scrollContainerRef,
    isDragging,
    setIsDragging,
    startX,
    setStartX,
    scrollLeft,
    setScrollLeft,
    selectedProject,
    repoSettingsProject,
    envSettingsEnvironment,
    isProjectBoardView,
    isCleanupTargetDeleting,
    isMerging,
    repoName,
    isLocalEnvironment,
    isLocalReady,
    isRunning,
    prUrl,
    prState,
    hasMergeConflicts,
    viewPR,
    setModeCreatePending,
    armRefreshAfterAgentCompletion,
    disarmRefreshAfterAgentCompletion,
    deleteEnvironment,
    hasPR,
    isPRMerged,
    cleanupTargetIsMerged,
    isPRClosed,
    isPRFinished,
    isSelectedEnvironmentDeleting,
    canCreateTab,
    canOpenEditor,
    environmentPortAddress,
    environmentBrowserUrl,
    browserPreviewSupported,
    canCopyEnvironmentUrl,
    handleOpenInEditor,
    handleCopyEnvironmentUrl,
    enabledAgentList,
    enabledAgents,
    configuredDefaultAgent,
    defaultAgent,
    launchDialogDefaultsFor,
    installLoopedReviewWorkflow,
    removeLoopedReviewWorkflow,
    handleReview,
    openReviewDialog,
    reviewLongPress,
    handleConfiguredReview,
    handleMultiReview,
    handleLoopedReview,
    handleRun,
    handleCreateScript,
    handleCreateAgentTab,
    handleCreateNativeTab,
    handleCreateBrowserTab,
    hasRunCommands,
    canRunCommands,
    handleRunButtonClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleCreatePR,
    canConfigurePR,
    openPrDialog,
    prLongPress,
    prEligibilityError,
    handleConfiguredCreatePR,
    handlePushChanges,
    handleResolveConflicts,
    resolveLaunchInFlight,
    canConfigureResolve,
    openResolveDialog,
    resolveLongPress,
    resolveEligibilityError,
    handleConfiguredResolve,
    handleCleanup,
    handleMergePR,
    targetBranch,
    sourceBranch,
  };
}
