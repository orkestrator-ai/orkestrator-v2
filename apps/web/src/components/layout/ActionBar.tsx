import {
  cloneElement,
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HoverTooltipContent, useHoverTooltip } from "@/components/ui/hover-tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertTriangle,
  Code2,
  Columns3,
  Container,
  Copy,
  ExternalLink,
  Eye,
  FilePlus2,
  FolderGit2,
  FolderTree,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  ListChecks,
  Loader2,
  Play,
  Plus,
  Shield,
  SlidersHorizontal,
  StickyNote,
  Trash2,
  Upload,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { ClaudeIcon, CodexIcon, OpenCodeIcon, DockerIcon } from "@/components/icons/AgentIcons";
import { useUIStore, useEnvironmentStore, useProjectStore, useConfigStore, useFilesPanelStore, type ProjectBoardTab } from "@/stores";
import { useShallow } from "zustand/react/shallow";
import { useTerminalContext, MAX_TABS, type AgentLaunchModeOverride } from "@/contexts";
import { usePullRequest, useProjects, useEnvironments } from "@/hooks";
import {
  createPRPrompt,
  createReviewPrompt,
  createPushChangesPrompt,
  createResolveConflictsPrompt,
  createOrkestratorScriptPrompt,
} from "@/prompts";
import { RepositorySettings, SettingsPage } from "@/components/settings";
import { EnvironmentSettingsDialog } from "@/components/environments/EnvironmentSettingsDialog";
import { DockerStatsDialog } from "@/components/docker";
import * as backend from "@/lib/backend";
import { useKanbanStore, findTaskForEnvironment } from "@/stores/kanbanStore";
import { getEnvironmentPortAddress } from "@/lib/environment-address";
import { cn } from "@/lib/utils";

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return !!target.closest("input, textarea, select, [contenteditable='true'], .xterm");
}

const ToolbarTooltipsEnabledContext = createContext(true);

function ToolbarContextMenuTrigger({
  children,
  tooltip,
}: {
  children: ReactElement;
  tooltip: ReactNode;
}) {
  type TriggerProps = Record<string, unknown> & {
    onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
    onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
    onMouseEnter?: (event: ReactMouseEvent<HTMLElement>) => void;
    onMouseLeave?: (event: ReactMouseEvent<HTMLElement>) => void;
  };

  const tooltipAnchorRef = useRef<HTMLElement | null>(null);
  const tooltipState = useHoverTooltip();
  const tooltipsEnabled = useContext(ToolbarTooltipsEnabledContext);
  const child = children as ReactElement<TriggerProps>;
  const trigger = cloneElement(child, {
    "data-toolbar-custom-context-menu": "true",
    ref: tooltipAnchorRef,
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      child.props.onBlur?.(event);
      tooltipState.hide();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      child.props.onFocus?.(event);
      if (tooltipsEnabled) tooltipState.show();
    },
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
      child.props.onMouseEnter?.(event);
      if (tooltipsEnabled) tooltipState.show();
    },
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => {
      child.props.onMouseLeave?.(event);
      tooltipState.hide();
    },
  } as Partial<TriggerProps> & {
    "data-toolbar-custom-context-menu": string;
    ref: typeof tooltipAnchorRef;
  });

  return (
    <>
      <ContextMenuTrigger className="contents">{trigger}</ContextMenuTrigger>
      {tooltipsEnabled && (
        <HoverTooltipContent
          anchorRef={tooltipAnchorRef}
          open={tooltipState.open}
          onMouseEnter={tooltipState.show}
          onMouseLeave={tooltipState.hide}
        >
          {tooltip}
        </HoverTooltipContent>
      )}
    </>
  );
}

function ToolbarTooltipTrigger({
  children,
  tooltip,
}: {
  children: ReactElement;
  tooltip: ReactNode;
}) {
  const tooltipAnchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipState = useHoverTooltip();
  const tooltipsEnabled = useContext(ToolbarTooltipsEnabledContext);

  return (
    <span
      ref={tooltipAnchorRef}
      className="inline-flex"
      onBlur={tooltipState.hide}
      onFocus={tooltipsEnabled ? tooltipState.show : undefined}
      onMouseEnter={tooltipsEnabled ? tooltipState.show : undefined}
      onMouseLeave={tooltipState.hide}
    >
      {children}
      {tooltipsEnabled && (
        <HoverTooltipContent
          anchorRef={tooltipAnchorRef}
          open={tooltipState.open}
          onMouseEnter={tooltipState.show}
          onMouseLeave={tooltipState.hide}
        >
          {tooltip}
        </HoverTooltipContent>
      )}
    </span>
  );
}

interface ActionBarProps {
  presentation?: "bar" | "grid";
}

export function ActionBar({ presentation = "bar" }: ActionBarProps) {
  const isGrid = presentation === "grid";
  const { selectedEnvironmentId, selectedProjectId, projectBoardTab, setProjectBoardTab, setProjectBoardNotesOpen } = useUIStore();
  const { getEnvironmentById, updateEnvironment, isWorkspaceReady, isSetupScriptsRunning, setEnvironmentPR } = useEnvironmentStore(
    useShallow((state) => ({
      getEnvironmentById: state.getEnvironmentById,
      updateEnvironment: state.updateEnvironment,
      isWorkspaceReady: state.isWorkspaceReady,
      isSetupScriptsRunning: state.isSetupScriptsRunning,
      setEnvironmentPR: state.setEnvironmentPR,
    }))
  );
  const { getProjectById } = useProjectStore();
  const { updateProject } = useProjects();
  const { config } = useConfigStore();
  const { createTab, selectTab, closeActiveTab, tabCount } = useTerminalContext();
  const { isOpen: filesPanelOpen, togglePanel: toggleFilesPanel, changes } = useFilesPanelStore();

  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [envSettingsOpen, setEnvSettingsOpen] = useState(false);
  const [dockerStatsOpen, setDockerStatsOpen] = useState(false);
  const [isOpeningEditor, setIsOpeningEditor] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [runCommands, setRunCommands] = useState<string[] | null>(null);
  const [isLoadingRunCommands, setIsLoadingRunCommands] = useState(false);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Drag-to-scroll state for toolbar
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  const selectedEnvironment = selectedEnvironmentId
    ? getEnvironmentById(selectedEnvironmentId)
    : null;
  const selectedProject = selectedProjectId
    ? getProjectById(selectedProjectId)
    : null;
  const isProjectBoardView = !!selectedProject && !selectedEnvironment;

  const repoName = selectedProject?.name ?? null;
  const isLocalEnvironment = selectedEnvironment?.environmentType === "local";
  const isLocalReady = isLocalEnvironment && !!selectedEnvironment?.worktreePath;
  const isRunning = isLocalReady || selectedEnvironment?.status === "running";
  const workspaceReady = selectedEnvironmentId ? isWorkspaceReady(selectedEnvironmentId) : false;
  const setupRunning = selectedEnvironmentId ? isSetupScriptsRunning(selectedEnvironmentId) : false;

  const { prUrl, prState, hasMergeConflicts, viewPR, setModeCreatePending } = usePullRequest({
    environmentId: selectedEnvironmentId,
  });

  const { deleteEnvironment } = useEnvironments(selectedProjectId, {
    listenForRenameEvents: false,
  });

  const hasPR = !!prUrl;
  const isPRMerged = prState === "merged";
  const isPRClosed = prState === "closed";
  const isPRFinished = isPRMerged || isPRClosed;
  const canCreateTab = !!createTab && tabCount < MAX_TABS;
  // For containers, we need containerId; for local environments, we need worktreePath
  const canOpenEditor = isRunning && (
    (isLocalEnvironment && !!selectedEnvironment?.worktreePath) ||
    (!isLocalEnvironment && !!selectedEnvironment?.containerId)
  );
  const environmentPortAddress = getEnvironmentPortAddress(selectedEnvironment);
  const canCopyEnvironmentUrl = !!environmentPortAddress;

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
  }, [selectedEnvironment?.containerId, selectedEnvironment?.worktreePath, isLocalEnvironment, config.global.preferredEditor]);

  const handleCopyEnvironmentUrl = useCallback(() => {
    if (!environmentPortAddress) return;

    navigator.clipboard.writeText(environmentPortAddress).then(() => {
      toast.success("Copied URL", { description: environmentPortAddress });
    }).catch(() => {
      toast.error("Failed to copy URL");
    });
  }, [environmentPortAddress]);

  // Get the default agent - per-environment override takes precedence over global config
  const defaultAgent = selectedEnvironment?.defaultAgent || config.global.defaultAgent || "claude";

  // Handler for code review
  const handleReview = useCallback((agentOverride?: "claude" | "opencode" | "codex") => {
    if (!createTab || !selectedProjectId || !canCreateTab) return;

    const repoConfig = config.repositories[selectedProjectId];
    const targetBranch = repoConfig?.prBaseBranch || "main";
    const reviewPrompt = createReviewPrompt(targetBranch, config.global.reviewPrompt);

    createTab(agentOverride || defaultAgent, {
      initialPrompt: reviewPrompt,
      displayTitle: "Review",
      isReviewTab: true,
    });
  }, [createTab, selectedProjectId, canCreateTab, config.repositories, config.global.reviewPrompt, defaultAgent]);

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

    const readConfigPromise = isLocalEnvironment && worktreePath
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
                (command): command is string => typeof command === "string" && command.trim().length > 0,
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
  }, [selectedEnvironment?.containerId, selectedEnvironment?.worktreePath, isLocalEnvironment, isRunning, workspaceReady]);

  // Handler for run commands
  const handleRun = useCallback(() => {
    if (!createTab || !canCreateTab || !runCommands || runCommands.length === 0) return;

    createTab("plain", { initialCommands: runCommands });
  }, [createTab, canCreateTab, runCommands]);

  const handleCreateScript = useCallback((agentOverride?: "claude" | "opencode" | "codex") => {
    if (!createTab || !canCreateTab || !isRunning) return;

    const initialPrompt = createOrkestratorScriptPrompt(isLocalEnvironment);
    createTab(agentOverride || defaultAgent, { initialPrompt });
  }, [createTab, canCreateTab, isRunning, isLocalEnvironment, defaultAgent]);

  const handleCreateAgentTab = useCallback((
    agent: "claude" | "opencode" | "codex",
    agentLaunchMode?: AgentLaunchModeOverride,
  ) => {
    if (!createTab || !canCreateTab) return;

    createTab(agent, agentLaunchMode ? { agentLaunchMode } : undefined);
  }, [createTab, canCreateTab]);

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

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    e.preventDefault();
    const x = e.pageX - container.offsetLeft;
    const walk = (x - startX) * 1.5; // Multiplier for scroll speed
    container.scrollLeft = scrollLeft - walk;
  }, [isDragging, startX, scrollLeft]);

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

      if (
        e.ctrlKey &&
        e.shiftKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.toLowerCase() === "c"
      ) {
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

      switch (e.key.toLowerCase()) {
        case "t":
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("plain");
          }
          break;
        case "n":
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("claude");
          }
          break;
        case "m":
          if (canCreateTab) {
            e.preventDefault();
            createTab?.("opencode");
          }
          break;
        case "r":
          if (canCreateTab && selectedProjectId) {
            e.preventDefault();
            handleReview();
          }
          break;
        case "p":
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
        case "w":
          // Close active tab - always prevent default to avoid closing window
          if (closeActiveTab && tabCount > 0) {
            e.preventDefault();
            closeActiveTab();
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
    closeActiveTab,
    tabCount,
    canCreateTab,
    canOpenEditor,
    handleOpenInEditor,
    canCopyEnvironmentUrl,
    handleCopyEnvironmentUrl,
    selectedEnvironment,
    selectedProjectId,
    handleReview,
    canRunCommands,
    handleRun,
    toggleFilesPanel,
  ]);

  // Handler for PR creation - launches agent tab with PR workflow prompt
  const handleCreatePR = useCallback((agentOverride?: "claude" | "opencode" | "codex") => {
    if (!createTab || !selectedProjectId || !canCreateTab) return;

    const repoConfig = config.repositories[selectedProjectId];
    const targetBranch = repoConfig?.prBaseBranch || "main";
    const prPrompt = createPRPrompt(targetBranch);

    // Set monitoring mode to create-pending for faster PR detection (5s intervals)
    setModeCreatePending();

    createTab(agentOverride || defaultAgent, {
      initialPrompt: prPrompt,
      displayTitle: "PR",
    });
  }, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent, setModeCreatePending]);

  // Handler for pushing changes to an existing PR - launches agent tab with commit/push prompt
  const handlePushChanges = useCallback((agentOverride?: "claude" | "opencode" | "codex") => {
    if (!createTab || !canCreateTab) return;

    const pushPrompt = createPushChangesPrompt();
    createTab(agentOverride || defaultAgent, {
      initialPrompt: pushPrompt,
      displayTitle: "Git Push",
    });
  }, [createTab, canCreateTab, defaultAgent]);

  // Handler for resolving merge conflicts - launches agent tab with conflict resolution prompt
  const handleResolveConflicts = useCallback((agentOverride?: "claude" | "opencode" | "codex") => {
    if (!createTab || !selectedProjectId || !canCreateTab) return;

    const repoConfig = config.repositories[selectedProjectId];
    const targetBranch = repoConfig?.prBaseBranch || "main";
    const resolvePrompt = createResolveConflictsPrompt(targetBranch);

    createTab(agentOverride || defaultAgent, {
      initialPrompt: resolvePrompt,
      displayTitle: "Conflict",
    });
  }, [createTab, selectedProjectId, canCreateTab, config.repositories, defaultAgent]);

  // Handler for cleaning up (deleting) an environment after PR is merged/closed
  const handleCleanup = useCallback(async () => {
    if (!selectedEnvironmentId) return;

    setIsDeleting(true);
    setCleanupError(null);
    try {
      await deleteEnvironment(selectedEnvironmentId);
      setCleanupDialogOpen(false);
    } catch (err) {
      console.error("[ActionBar] Failed to delete environment:", err);
      const message = err instanceof Error ? err.message : "An unexpected error occurred";
      setCleanupError(message);
    } finally {
      setIsDeleting(false);
    }
  }, [selectedEnvironmentId, deleteEnvironment]);

  // Handler for merging a PR
  const handleMergePR = useCallback(async () => {
    if (!selectedEnvironmentId || !prUrl) return;

    // For container environments, we need a containerId
    // For local environments, we use the environmentId
    if (!isLocalEnvironment && !selectedEnvironment?.containerId) return;

    // Close dialog immediately and show spinner on main button
    setMergeDialogOpen(false);
    setIsMerging(true);
    setMergeError(null);

    try {
      // Use appropriate merge method based on environment type
      console.log("[ActionBar] Starting PR merge...");
      if (isLocalEnvironment) {
        await backend.mergePrLocal(selectedEnvironmentId, "squash", true);
      } else {
        await backend.mergePr(selectedEnvironment!.containerId!, "squash", true);
      }
      console.log("[ActionBar] Merge command completed successfully");

      // IMPORTANT: Immediately save the "merged" state after successful merge.
      // For container environments, `gh pr merge --delete-branch` checks out the base branch
      // (e.g., main) after deleting the feature branch. This means subsequent `gh pr view`
      // calls from the monitor service will fail to find the PR (since they're now running
      // from main branch context). By saving the merged state immediately, we ensure the
      // cleanup button appears regardless of what the monitor detects afterward.
      console.log("[ActionBar] Saving merged state immediately...");
      try {
        await backend.setEnvironmentPr(selectedEnvironmentId, prUrl, "merged", false);
        setEnvironmentPR(selectedEnvironmentId, prUrl, "merged", false);
        console.log("[ActionBar] Merged state saved");
      } catch (saveErr) {
        // State save failed but merge succeeded - log warning and continue
        // The monitor service may still detect the merged state eventually
        console.warn("[ActionBar] Failed to save merged state:", saveErr);
      }

      // Add "PR merged" comment to the associated ticket
      try {
        const { task, taskId } = findTaskForEnvironment(selectedEnvironmentId);
        if (taskId && !task?.prMergeCommented) {
          const kanbanState = useKanbanStore.getState();
          await kanbanState.addComment(taskId, "🎉 PR merged");
          await kanbanState.updateTask(taskId, { prState: "merged", prMergeCommented: true });
        }
      } catch (commentErr) {
        console.warn("[ActionBar] Failed to add PR merged comment:", commentErr);
      }

      // Clear the merging spinner
      setIsMerging(false);

    } catch (err) {
      console.error("[ActionBar] Failed to merge PR:", err);
      // backend invoke errors come as strings, not Error objects
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "An unexpected error occurred";
      setMergeError(message);
      setMergeDialogOpen(true); // Re-open dialog to show error
      setIsMerging(false);
    }
  }, [selectedEnvironment?.containerId, selectedEnvironmentId, prUrl, isLocalEnvironment, setEnvironmentPR]);

  // Get target branch for PR dialog
  const targetBranch = selectedProjectId
    ? config.repositories[selectedProjectId]?.prBaseBranch || "main"
    : "main";
  const sourceBranch = selectedEnvironment?.branch || "current branch";

  return (
    <>
      <ToolbarTooltipsEnabledContext.Provider value={!isGrid}>
        <div
          data-mobile-toolbar
          data-presentation={presentation}
          className={cn(
            "bg-[#212124]",
            isGrid
              ? "max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-xl border border-border/80 shadow-2xl shadow-black/50 [&_button]:h-11 [&_button]:w-full [&_button]:justify-start [&_button]:gap-2 [&_button]:rounded-lg [&_button]:px-3"
              : "flex h-14 shrink-0 items-center border-b border-border/80 md:h-12",
          )}
        >
        {/* Scrollable toolbar area */}
        <div
          ref={scrollContainerRef}
          className={cn(
            isGrid
              ? "grid min-w-0 grid-cols-2 gap-2 p-2"
              : "flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-2 md:px-4 [&::-webkit-scrollbar]:hidden",
            isDragging && !isGrid && "cursor-grabbing select-none",
          )}
          onMouseDown={isGrid ? undefined : handleMouseDown}
          onMouseMove={isGrid ? undefined : handleMouseMove}
          onMouseUp={isGrid ? undefined : handleMouseUp}
          onMouseLeave={isGrid ? undefined : handleMouseLeave}
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {/* Left side: Controls */}
          <div
            className={cn(
              isGrid
                ? "col-span-2 grid grid-cols-2 gap-2"
                : "flex shrink-0 items-center gap-2",
            )}
          >
          <ToolbarTooltipTrigger tooltip="Global settings">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setGlobalSettingsOpen(true)}
                aria-label="Global settings"
              >
                <SlidersHorizontal className="h-4 w-4" />
                {isGrid && <span className="truncate text-xs">Global settings</span>}
              </Button>
          </ToolbarTooltipTrigger>

          <ToolbarTooltipTrigger tooltip="Docker configuration">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setDockerStatsOpen(true)}
                aria-label="Docker configuration"
              >
                <DockerIcon className="h-4 w-4" />
                {isGrid && <span className="truncate text-xs">Docker</span>}
              </Button>
          </ToolbarTooltipTrigger>

          {(isGrid || repoName) && (
            <ToolbarTooltipTrigger tooltip={selectedProject ? "Repository settings" : "Select a project first"}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setRepoSettingsOpen(true)}
                  aria-label="Repository settings"
                  disabled={!selectedProject}
                >
                  <FolderGit2 className="h-4 w-4" />
                  {isGrid && <span className="truncate text-xs">Repository settings</span>}
                </Button>
            </ToolbarTooltipTrigger>
          )}

          {(isGrid || selectedEnvironment) && (
            <ToolbarTooltipTrigger tooltip={selectedEnvironment ? "Environment settings" : "Select an environment first"}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setEnvSettingsOpen(true)}
                  aria-label="Environment settings"
                  disabled={!selectedEnvironment}
                >
                  <Container className="h-4 w-4" />
                  {isGrid && <span className="truncate text-xs">Env. settings</span>}
                </Button>
            </ToolbarTooltipTrigger>
          )}

          {/* Terminal tab buttons */}
          {(isGrid || selectedEnvironment) && (
            <>
              <div className={cn("mx-2 h-4 w-px bg-border", isGrid && "hidden")} />
              <ToolbarTooltipTrigger
                tooltip={
                  <>
                    <p>New Terminal Tab</p>
                    <p className="text-xs text-muted-foreground">⌘T</p>
                  </>
                }
              >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => createTab?.("plain")}
                    disabled={!selectedEnvironment || !canCreateTab}
                    aria-label="New terminal tab"
                  >
                    <Plus className="h-4 w-4" />
                    {isGrid && <span className="truncate text-xs">New terminal</span>}
                  </Button>
              </ToolbarTooltipTrigger>

              <ToolbarTooltipTrigger
                tooltip={
                  <>
                    <p>New Root Terminal</p>
                    <p className="text-xs text-red-500">Full root privileges inside container</p>
                  </>
                }
              >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => createTab?.("root")}
                    disabled={!selectedEnvironment || !canCreateTab}
                    aria-label="New root terminal"
                  >
                    <Shield className="h-4 w-4" />
                    {isGrid && <span className="truncate text-xs">Root terminal</span>}
                  </Button>
              </ToolbarTooltipTrigger>

              <ContextMenu>
                <ToolbarContextMenuTrigger
                  tooltip={
                    <>
                      <p>New Tab with Claude</p>
                      <p className="text-xs text-muted-foreground">⌘N · Right-click for mode</p>
                    </>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleCreateAgentTab("claude")}
                    disabled={!selectedEnvironment || !canCreateTab}
                    aria-label="New tab with Claude"
                  >
                    <ClaudeIcon className="h-4 w-4" />
                    {isGrid && <span className="truncate text-xs">New Claude tab</span>}
                  </Button>
                </ToolbarContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => handleCreateAgentTab("claude", "cli")} disabled={!canCreateTab}>
                    <ClaudeIcon className="mr-2 h-4 w-4" />
                    Claude CLI
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleCreateAgentTab("claude", "native")} disabled={!canCreateTab}>
                    <ClaudeIcon className="mr-2 h-4 w-4" />
                    Claude Native
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleCreateAgentTab("claude", "tmux")} disabled={!canCreateTab}>
                    <ClaudeIcon className="mr-2 h-4 w-4" />
                    Claude Tmux
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              <ContextMenu>
                <ToolbarContextMenuTrigger
                  tooltip={
                    <>
                      <p>New Tab with OpenCode</p>
                      <p className="text-xs text-muted-foreground">⌘M · Right-click for mode</p>
                    </>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleCreateAgentTab("opencode")}
                    disabled={!selectedEnvironment || !canCreateTab}
                    aria-label="New tab with OpenCode"
                  >
                    <OpenCodeIcon className="h-4 w-4" />
                    {isGrid && <span className="truncate text-xs">New OpenCode tab</span>}
                  </Button>
                </ToolbarContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => handleCreateAgentTab("opencode", "cli")} disabled={!canCreateTab}>
                    <OpenCodeIcon className="mr-2 h-4 w-4" />
                    OpenCode CLI
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleCreateAgentTab("opencode", "native")} disabled={!canCreateTab}>
                    <OpenCodeIcon className="mr-2 h-4 w-4" />
                    OpenCode Native
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              <ContextMenu>
                <ToolbarContextMenuTrigger
                  tooltip={
                    <>
                      <p>New Tab with Codex</p>
                      <p className="text-xs text-muted-foreground">Right-click for mode</p>
                    </>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleCreateAgentTab("codex")}
                    disabled={!selectedEnvironment || !canCreateTab}
                    aria-label="New tab with Codex"
                  >
                    <CodexIcon className="h-4 w-4" />
                    {isGrid && <span className="truncate text-xs">New Codex tab</span>}
                  </Button>
                </ToolbarContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => handleCreateAgentTab("codex", "cli")} disabled={!canCreateTab}>
                    <CodexIcon className="mr-2 h-4 w-4" />
                    Codex CLI
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleCreateAgentTab("codex", "native")} disabled={!canCreateTab}>
                    <CodexIcon className="mr-2 h-4 w-4" />
                    Codex Native
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              <ContextMenu>
                <ToolbarContextMenuTrigger
                  tooltip={
                    <>
                      <p>Code Review</p>
                      <p className="text-xs text-muted-foreground">Commit changes and review code</p>
                      <p className="text-xs text-muted-foreground">⌘R · Right-click for agent</p>
                    </>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleReview()}
                    disabled={!selectedEnvironment || !canCreateTab}
                    aria-label="Code review"
                  >
                    <Eye className="h-4 w-4" />
                    {isGrid && <span className="truncate text-xs">Code review</span>}
                  </Button>
                </ToolbarContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => handleReview("claude")}>
                    <ClaudeIcon className="mr-2 h-4 w-4" />
                    Review with Claude
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleReview("opencode")}>
                    <OpenCodeIcon className="mr-2 h-4 w-4" />
                    Review with OpenCode
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleReview("codex")}>
                    <CodexIcon className="mr-2 h-4 w-4" />
                    Review with Codex
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              {/* Play Button - Run Commands */}
              <ContextMenu>
                <ToolbarContextMenuTrigger
                  tooltip={
                    <>
                      <p>Run Commands</p>
                      <p className="text-xs text-muted-foreground">
                        {setupRunning
                          ? "Waiting for setup scripts to finish..."
                          : hasRunCommands
                            ? "Execute run commands from orkestrator-ai.json"
                            : "Add 'run' array to orkestrator-ai.json to enable"}
                      </p>
                      <p className="text-xs text-muted-foreground">⌘P · Right-click for script menu</p>
                    </>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 ${!canRunCommands ? "opacity-50 cursor-not-allowed" : ""}`}
                    onClick={handleRunButtonClick}
                    aria-disabled={!canRunCommands}
                    aria-label="Run commands"
                    disabled={!selectedEnvironment}
                  >
                    {isLoadingRunCommands || setupRunning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {isGrid && <span className="truncate text-xs">Run commands</span>}
                  </Button>
                </ToolbarContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onClick={handleRun}
                    disabled={!canRunCommands}
                  >
                    <Play className="mr-2 h-4 w-4" />
                    Run Commands
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => handleCreateScript("claude")}
                    disabled={!canCreateTab || !isRunning}
                  >
                    <FilePlus2 className="mr-2 h-4 w-4" />
                    Create Script with Claude
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => handleCreateScript("opencode")}
                    disabled={!canCreateTab || !isRunning}
                  >
                    <FilePlus2 className="mr-2 h-4 w-4" />
                    Create Script with OpenCode
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => handleCreateScript("codex")}
                    disabled={!canCreateTab || !isRunning}
                  >
                    <FilePlus2 className="mr-2 h-4 w-4" />
                    Create Script with Codex
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <div className={cn("mx-2 h-4 w-px bg-border", isGrid && "hidden")} />

              <ToolbarTooltipTrigger
                tooltip={
                  <>
                    <p>Open in {config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"}</p>
                    <p className="text-xs text-muted-foreground">⌘O</p>
                  </>
                }
              >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleOpenInEditor}
                    disabled={!canOpenEditor || isOpeningEditor}
                    aria-label={`Open in ${config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"}`}
                  >
                    {isOpeningEditor ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Code2 className="h-4 w-4" />
                    )}
                    {isGrid && (
                      <span className="truncate text-xs">
                        Open in {config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"}
                      </span>
                    )}
                  </Button>
              </ToolbarTooltipTrigger>

              <ToolbarTooltipTrigger
                tooltip={
                  <>
                    <p>{environmentPortAddress ? "Copy URL" : "No mapped URL"}</p>
                    {environmentPortAddress && (
                      <p className="text-xs text-muted-foreground">{environmentPortAddress}</p>
                    )}
                    {environmentPortAddress && <p className="text-xs text-muted-foreground">Ctrl⇧C</p>}
                  </>
                }
              >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleCopyEnvironmentUrl}
                    disabled={!canCopyEnvironmentUrl}
                    aria-label={environmentPortAddress ? "Copy URL" : "No mapped URL"}
                  >
                    <Copy className="h-4 w-4" />
                    {isGrid && (
                      <span className="truncate text-xs">
                        {environmentPortAddress ? "Copy URL" : "No mapped URL"}
                      </span>
                    )}
                  </Button>
              </ToolbarTooltipTrigger>

              <div className={cn("mx-2 h-4 w-px bg-border", isGrid && "hidden")} />
            </>
          )}

          {(isGrid || selectedEnvironment) && !hasPR && (
            <ContextMenu>
              <ToolbarContextMenuTrigger
                tooltip={
                  !isRunning
                    ? "Container must be running"
                    : !canCreateTab
                      ? "Maximum tabs reached"
                      : "Launch agent to create a pull request (right-click for agent)"
                }
              >
                <Button
                  variant={isGrid ? "ghost" : "default"}
                  size="sm"
                  className="gap-2"
                  onClick={() => handleCreatePR()}
                  disabled={!isRunning || !canCreateTab}
                >
                  <GitPullRequest className="h-4 w-4" />
                  <span className={cn(isGrid && "truncate text-xs")}>Create PR</span>
                </Button>
              </ToolbarContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => handleCreatePR("claude")}>
                  <ClaudeIcon className="mr-2 h-4 w-4" />
                  Create PR with Claude
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleCreatePR("opencode")}>
                  <OpenCodeIcon className="mr-2 h-4 w-4" />
                  Create PR with OpenCode
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleCreatePR("codex")}>
                  <CodexIcon className="mr-2 h-4 w-4" />
                  Create PR with Codex
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )}

          {selectedEnvironment && hasPR && (
            <>
              <ToolbarTooltipTrigger
                tooltip={
                  isPRMerged
                    ? "PR has been merged - click to view"
                    : isPRClosed
                      ? "PR was closed without merging - click to view"
                      : "Open PR in browser"
                }
              >
                  <Button
                    variant={isGrid ? "ghost" : isPRFinished ? "secondary" : "outline"}
                    size="sm"
                    className="gap-2"
                    onClick={viewPR}
                  >
                    {isPRMerged ? (
                      <GitMerge className="h-4 w-4" />
                    ) : isPRClosed ? (
                      <GitPullRequestClosed className="h-4 w-4" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    <span className={cn(isGrid && "truncate text-xs")}>
                      {isPRMerged ? "PR Merged" : isPRClosed ? "PR Closed" : "View PR"}
                    </span>
                  </Button>
              </ToolbarTooltipTrigger>

              {!isPRFinished && hasMergeConflicts === false && (
                <ToolbarTooltipTrigger
                  tooltip={
                    isMerging
                      ? "Merge in progress..."
                      : !isRunning
                        ? (isLocalEnvironment ? "Environment must be ready" : "Container must be running")
                        : "Squash and merge this PR"
                  }
                >
                    <Button
                      variant={isGrid ? "ghost" : "default"}
                      size="sm"
                      className={cn(
                        "gap-2",
                        !isGrid && "bg-green-600 text-white hover:bg-green-700",
                      )}
                      onClick={() => !isMerging && setMergeDialogOpen(true)}
                      disabled={!isRunning || isMerging}
                    >
                      {isMerging ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className={cn(isGrid && "truncate text-xs")}>Merging...</span>
                        </>
                      ) : (
                        <>
                          <GitMerge className="h-4 w-4" />
                          <span className={cn(isGrid && "truncate text-xs")}>Merge PR</span>
                        </>
                      )}
                    </Button>
                </ToolbarTooltipTrigger>
              )}

              {!isPRFinished && hasMergeConflicts && (
                <ContextMenu>
                  <ToolbarContextMenuTrigger
                    tooltip={
                      !isRunning
                        ? (isLocalEnvironment ? "Environment must be ready" : "Container must be running")
                        : !canCreateTab
                          ? "Maximum tabs reached"
                          : "PR has merge conflicts - launch agent to resolve them"
                    }
                  >
                    <Button
                      variant={isGrid ? "ghost" : "destructive"}
                      size="sm"
                      className="gap-2"
                      onClick={() => handleResolveConflicts()}
                      disabled={!isRunning || !canCreateTab}
                    >
                      <AlertTriangle className="h-4 w-4" />
                      <span className={cn(isGrid && "truncate text-xs")}>Resolve</span>
                    </Button>
                  </ToolbarContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => handleResolveConflicts("claude")}>
                      <ClaudeIcon className="mr-2 h-4 w-4" />
                      Resolve with Claude
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleResolveConflicts("opencode")}>
                      <OpenCodeIcon className="mr-2 h-4 w-4" />
                      Resolve with OpenCode
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleResolveConflicts("codex")}>
                      <CodexIcon className="mr-2 h-4 w-4" />
                      Resolve with Codex
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )}

              {isPRFinished && (
                <ToolbarTooltipTrigger
                  tooltip={`Delete this environment (PR is ${isPRMerged ? "merged" : "closed"})`}
                >
                    <Button
                      variant={isGrid ? "ghost" : "destructive"}
                      size="sm"
                      className="gap-2"
                      onClick={() => setCleanupDialogOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className={cn(isGrid && "truncate text-xs")}>Clean Up</span>
                    </Button>
                </ToolbarTooltipTrigger>
              )}

              {!isPRFinished && changes.length > 0 && (
                <ContextMenu>
                  <ToolbarContextMenuTrigger
                    tooltip={
                      !isRunning
                        ? "Container must be running"
                        : !canCreateTab
                          ? "Maximum tabs reached"
                          : "Launch agent to commit and push changes"
                    }
                  >
                    <Button
                      variant={isGrid ? "ghost" : "default"}
                      size="sm"
                      className="gap-2"
                      onClick={() => handlePushChanges()}
                      disabled={!isRunning || !canCreateTab}
                    >
                      <Upload className="h-4 w-4" />
                      <span className={cn(isGrid && "truncate text-xs")}>Push Changes</span>
                    </Button>
                  </ToolbarContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => handlePushChanges("claude")}>
                      <ClaudeIcon className="mr-2 h-4 w-4" />
                      Push with Claude
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handlePushChanges("opencode")}>
                      <OpenCodeIcon className="mr-2 h-4 w-4" />
                      Push with OpenCode
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handlePushChanges("codex")}>
                      <CodexIcon className="mr-2 h-4 w-4" />
                      Push with Codex
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )}
            </>
          )}
        </div>

          {/* Spacer to push right side content to the end */}
          <div className={cn("min-w-4 flex-1", isGrid && "hidden")} />

          {/* Right side: Board tabs, repo name, and Files toggle */}
          <div
            className={cn(
              isGrid
                ? "col-span-2 grid grid-cols-2 gap-2"
                : "flex shrink-0 items-center gap-2",
            )}
          >
            {isGrid ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setProjectBoardNotesOpen(true)}
                  aria-label="Project notes"
                  disabled={!isProjectBoardView || projectBoardTab !== "kanban"}
                >
                  <StickyNote className="h-4 w-4" />
                  <span className="truncate text-xs">Project notes</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    projectBoardTab === "kanban" &&
                      "bg-primary/15 text-blue-300 ring-1 ring-inset ring-primary/50 hover:bg-primary/20 hover:text-blue-200",
                  )}
                  onClick={() => setProjectBoardTab("kanban")}
                  aria-label="Kanban board"
                  aria-pressed={projectBoardTab === "kanban"}
                  disabled={!isProjectBoardView}
                >
                  <Columns3 className="h-4 w-4" />
                  <span className="truncate text-xs">Kanban board</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    projectBoardTab === "linear" &&
                      "bg-primary/15 text-blue-300 ring-1 ring-inset ring-primary/50 hover:bg-primary/20 hover:text-blue-200",
                  )}
                  onClick={() => setProjectBoardTab("linear")}
                  aria-label="Linear pipeline"
                  aria-pressed={projectBoardTab === "linear"}
                  disabled={!isProjectBoardView}
                >
                  <Workflow className="h-4 w-4" />
                  <span className="truncate text-xs">Linear pipeline</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    projectBoardTab === "features" &&
                      "bg-primary/15 text-blue-300 ring-1 ring-inset ring-primary/50 hover:bg-primary/20 hover:text-blue-200",
                  )}
                  onClick={() => setProjectBoardTab("features")}
                  aria-label="Features"
                  aria-pressed={projectBoardTab === "features"}
                  disabled={!isProjectBoardView}
                >
                  <ListChecks className="h-4 w-4" />
                  <span className="truncate text-xs">Features</span>
                </Button>
              </>
            ) : isProjectBoardView ? (
              <>
                {projectBoardTab === "kanban" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setProjectBoardNotesOpen(true)}
                  >
                    <StickyNote className="h-3.5 w-3.5" />
                    Project Notes
                  </Button>
                )}
                <Tabs
                  value={projectBoardTab}
                  onValueChange={(value) => setProjectBoardTab(value as ProjectBoardTab)}
                >
                  <TabsList className="h-8 bg-zinc-900/80">
                    <TabsTrigger value="kanban" className="px-2 text-xs data-[state=active]:!bg-primary/15 data-[state=active]:!text-blue-300 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/50">Kanban</TabsTrigger>
                    <TabsTrigger value="linear" className="px-2 text-xs data-[state=active]:!bg-primary/15 data-[state=active]:!text-blue-300 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/50">Linear</TabsTrigger>
                    <TabsTrigger value="features" className="px-2 text-xs data-[state=active]:!bg-primary/15 data-[state=active]:!text-blue-300 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/50">Features</TabsTrigger>
                  </TabsList>
                </Tabs>
              </>
            ) : repoName && !isGrid ? (
              <span className="whitespace-nowrap text-sm font-medium text-foreground">
                {repoName}
              </span>
            ) : !isGrid ? (
              <span className="whitespace-nowrap text-sm text-muted-foreground">
                Select an environment to get started
              </span>
            ) : null}

            {(isGrid || selectedEnvironment) && (
              <ToolbarTooltipTrigger
                tooltip={
                  <>
                    <p>{filesPanelOpen ? "Hide" : "Show"} file panel</p>
                    <p className="text-xs text-muted-foreground">⌘E</p>
                  </>
                }
              >
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "relative h-8 w-8",
                      filesPanelOpen &&
                        "bg-primary/15 text-blue-300 ring-1 ring-inset ring-primary/50 hover:bg-primary/20 hover:text-blue-200",
                    )}
                    onClick={toggleFilesPanel}
                    aria-label={`${filesPanelOpen ? "Hide" : "Show"} file panel`}
                    aria-pressed={filesPanelOpen}
                    disabled={!selectedEnvironment}
                  >
                    <FolderTree className="h-4 w-4" />
                    {isGrid ? (
                      <span className="flex min-w-0 items-center gap-1.5 text-xs">
                        <span className="truncate">
                          {filesPanelOpen ? "Hide files" : "Show files"}
                        </span>
                        {changes.length > 0 && !filesPanelOpen && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-primary"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                    ) : changes.length > 0 && !filesPanelOpen ? (
                      <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-primary" />
                    ) : null}
                  </Button>
              </ToolbarTooltipTrigger>
            )}
          </div>
        </div>
        </div>
      </ToolbarTooltipsEnabledContext.Provider>

      {/* Settings Dialogs */}
      <SettingsPage open={globalSettingsOpen} onOpenChange={setGlobalSettingsOpen} />
      <DockerStatsDialog open={dockerStatsOpen} onOpenChange={setDockerStatsOpen} />

      {selectedProject && (
        <RepositorySettings
          project={selectedProject}
          open={repoSettingsOpen}
          onOpenChange={setRepoSettingsOpen}
          onUpdateProject={updateProject}
        />
      )}

      {selectedEnvironment && (
        <EnvironmentSettingsDialog
          open={envSettingsOpen}
          onOpenChange={setEnvSettingsOpen}
          environment={selectedEnvironment}
          onUpdate={(updated) => updateEnvironment(updated.id, updated)}
          onRestart={backend.recreateEnvironment}
        />
      )}

      {/* Editor Error Dialog */}
      <AlertDialog open={!!editorError} onOpenChange={() => setEditorError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Failed to Open Editor</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>{editorError}</p>
              <p className="text-xs">
                Make sure you have the {config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"} CLI
                installed and the Dev Containers extension is enabled.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setEditorError(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cleanup Environment Confirmation Dialog */}
      <AlertDialog
        open={cleanupDialogOpen}
        onOpenChange={(open) => {
          setCleanupDialogOpen(open);
          if (!open) setCleanupError(null); // Clear error when closing
        }}
      >
        <AlertDialogContent className="max-h-[calc(100vh-2rem)] overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>Clean Up Environment</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the environment "{selectedEnvironment?.name}".
              The PR has been {isPRMerged ? "merged" : "closed"}, so this environment is no longer needed.
              {isPRMerged ? " The PR's remote branch will also be deleted if it still exists." : ""}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cleanupError && (
            <div className="min-w-0 max-h-[min(16rem,40vh)] overflow-y-auto overflow-x-hidden rounded-md bg-destructive/10 p-3 text-sm text-destructive whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              Failed to delete environment: {cleanupError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCleanup}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete Environment"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Merge PR Confirmation Dialog */}
      <AlertDialog
        open={mergeDialogOpen}
        onOpenChange={(open) => {
          setMergeDialogOpen(open);
          if (!open) setMergeError(null); // Clear error when closing
        }}
      >
        <AlertDialogContent className="max-h-[calc(100vh-2rem)] overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>Merge Pull Request</AlertDialogTitle>
            <AlertDialogDescription>
              This will squash and merge <span className="font-semibold">{sourceBranch}</span> into <span className="font-semibold">{targetBranch}</span>.
              The feature branch will be deleted after merging.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mergeError && (
            <div className="min-w-0 max-h-[min(16rem,40vh)] overflow-y-auto overflow-x-hidden rounded-md bg-destructive/10 p-3 text-sm text-destructive whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              Failed to merge PR: {mergeError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleMergePR}
              className="bg-green-600 text-white hover:bg-green-700"
            >
              Merge PR
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
