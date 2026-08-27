import {
  cloneElement,
  createContext,
  lazy,
  useContext,
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
  Github,
  Globe2,
  ListChecks,
  Loader2,
  Play,
  Plus,
  Repeat2,
  Shield,
  SlidersHorizontal,
  StickyNote,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  Workflow,
} from "lucide-react";
import {
  ClaudeIcon,
  CodexIcon,
  CursorAgentIcon,
  GrokBuildIcon,
  OpenCodeIcon,
  DockerIcon,
} from "@/components/icons/AgentIcons";
import type { ProjectBoardTab } from "@/stores";
import { DockerStatsDialog } from "@/components/docker";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";
import { ReviewLaunchDialog } from "@/components/review/ReviewLaunchDialog";
import { MultiReviewLaunchDialog, StackedEyes } from "@/components/review/MultiReviewLaunchDialog";
import { AgentLaunchDialog } from "@/components/launch/AgentLaunchDialog";
import { resolveDefaultReviewTabType } from "@/lib/review-launch-options";
import { MOBILE_SHELL_MEDIA_QUERY, MOBILE_TOOLS_TRIGGER_SELECTOR } from "./MobileAppShellLayout";
import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { useActionBarController } from "./useActionBarController";

const LazyRepositorySettings = lazy(async () => ({
  default: (await import("@/components/settings/RepositorySettings")).RepositorySettings,
}));
const LazySettingsPage = lazy(async () => ({
  default: (await import("@/components/settings/SettingsPage")).SettingsPage,
}));
const LazyEnvironmentSettingsDialog = lazy(async () => ({
  default: (await import("@/components/environments/EnvironmentSettingsDialog"))
    .EnvironmentSettingsDialog,
}));

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
      if (tooltipsEnabled) tooltipState.showImmediately();
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
      onFocus={tooltipsEnabled ? tooltipState.showImmediately : undefined}
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

/**
 * The outcome of a conflict-resolution launch.
 *
 * `message` is null when nothing was attempted — a busy launch or a missing
 * prerequisite the caller's own controls already express — so the caller must
 * not turn it into an error the user did not cause.
 */

export function ActionBar({ presentation = "bar" }: ActionBarProps) {
  const {
    dockerAvailable,
    isGrid,
    selectedProjectId,
    projectBoardTab,
    setProjectBoardTab,
    setProjectBoardNotesOpen,
    updateEnvironment,
    selectedEnvironment,
    workspaceReady,
    setupRunning,
    updateProject,
    config,
    createTab,
    filesPanelOpen,
    toggleFilesPanel,
    changes,
    setRepoSettingsProjectId,
    globalSettingsOpen,
    setGlobalSettingsOpen,
    setEnvSettingsEnvironmentId,
    dockerStatsOpen,
    setDockerStatsOpen,
    isOpeningEditor,
    editorError,
    setEditorError,
    isLoadingRunCommands,
    cleanupDialogOpen,
    setCleanupDialogOpen,
    cleanupTarget,
    setCleanupTarget,
    cleanupError,
    setCleanupError,
    mergeDialogOpen,
    setMergeDialogOpen,
    mergeError,
    setMergeError,
    resolveLaunchEnvironmentIdRef,
    reviewDialogOpen,
    setReviewDialogOpen,
    loopedReviewDialogOpen,
    setLoopedReviewDialogOpen,
    multiReviewDialogOpen,
    setMultiReviewDialogOpen,
    multiReviewLaunchPending,
    multiReviewLaunchInFlightRef,
    loopedReviewLaunchPending,
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
    reviewModelCatalog,
    scrollContainerRef,
    isDragging,
    selectedProject,
    repoSettingsProject,
    envSettingsEnvironment,
    isProjectBoardView,
    isCleanupTargetDeleting,
    isMerging,
    repoName,
    isLocalEnvironment,
    isRunning,
    hasMergeConflicts,
    viewPR,
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
    launchDialogDefaultsFor,
    configuredLaunchDialogDefaultsFor,
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
    openPrDialog,
    prLongPress,
    prEligibilityError,
    handleConfiguredCreatePR,
    handlePushChanges,
    handleResolveConflicts,
    resolveLaunchInFlight,
    openResolveDialog,
    resolveLongPress,
    resolveEligibilityError,
    handleConfiguredResolve,
    handleCleanup,
    handleMergePR,
    targetBranch,
    sourceBranch,
  } = useActionBarController({ presentation });

  // Configure dialogs open on the Settings action default, which is the same
  // value `actionDefaultFor` gives a plain click on the same button.
  const reviewLaunchDefaults = launchDialogDefaultsFor("review");
  // These roles did not exist in older configs. An unset or disabled entry
  // keeps the previous behaviour of following Review rather than silently
  // switching to the environment's generic agent.
  const review2LaunchDefaults = configuredLaunchDialogDefaultsFor("review2");
  const fixReviewIssuesLaunchDefaults = configuredLaunchDialogDefaultsFor("fixReviewIssues");
  const prLaunchDefaults = launchDialogDefaultsFor("pr");
  const resolveLaunchDefaults = launchDialogDefaultsFor("resolve");

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
                isGrid ? "col-span-2 grid grid-cols-2 gap-2" : "flex shrink-0 items-center gap-2",
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

              <ToolbarTooltipTrigger
                tooltip={dockerAvailable ? "Docker configuration" : "Docker is not running"}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setDockerStatsOpen(true)}
                  aria-label="Docker configuration"
                  disabled={!dockerAvailable}
                >
                  <DockerIcon className="h-4 w-4" />
                  {isGrid && <span className="truncate text-xs">Docker</span>}
                </Button>
              </ToolbarTooltipTrigger>

              {(isGrid || repoName) && (
                <ToolbarTooltipTrigger
                  tooltip={selectedProject ? "Repository settings" : "Select a project first"}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setRepoSettingsProjectId(selectedProject?.id ?? null)}
                    aria-label="Repository settings"
                    disabled={!selectedProject}
                  >
                    <FolderGit2 className="h-4 w-4" />
                    {isGrid && <span className="truncate text-xs">Repository settings</span>}
                  </Button>
                </ToolbarTooltipTrigger>
              )}

              {(isGrid || selectedEnvironment) && (
                <ToolbarTooltipTrigger
                  tooltip={
                    selectedEnvironment ? "Environment settings" : "Select an environment first"
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setEnvSettingsEnvironmentId(selectedEnvironment?.id ?? null)}
                    aria-label="Environment settings"
                    disabled={!selectedEnvironment}
                  >
                    <Container className="h-4 w-4" />
                    {isGrid && <span className="truncate text-xs">Env. settings</span>}
                  </Button>
                </ToolbarTooltipTrigger>
              )}

              {/* Primary native-agent and terminal tab controls */}
              {(isGrid || selectedEnvironment) && (
                <>
                  <div className={cn("mx-2 h-4 w-px bg-border", isGrid && "hidden")} />
                  <ContextMenu>
                    <ToolbarContextMenuTrigger
                      tooltip={
                        <>
                          <p>New Native Agent Tab</p>
                          <p className="text-xs text-muted-foreground">
                            ⌘N · Right-click for options
                          </p>
                        </>
                      }
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={handleCreateNativeTab}
                        disabled={!selectedEnvironment || !canCreateTab}
                        aria-label="New native agent tab"
                      >
                        <Plus className="h-4 w-4" />
                        {isGrid && <span className="truncate text-xs">New agent</span>}
                      </Button>
                    </ToolbarContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={handleCreateNativeTab} disabled={!canCreateTab}>
                        <Plus className="mr-2 h-4 w-4" />
                        Native Tab
                      </ContextMenuItem>
                      {enabledAgents.has("claude") && (
                        <ContextMenuItem
                          onClick={() => handleCreateAgentTab("claude", "tmux")}
                          disabled={!canCreateTab}
                        >
                          <ClaudeIcon className="mr-2 h-4 w-4" />
                          Claude Tmux Tab
                        </ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>

                  <ContextMenu>
                    <ToolbarContextMenuTrigger
                      tooltip={
                        <>
                          <p>New Terminal Tab</p>
                          <p className="text-xs text-muted-foreground">
                            ⌘T · Right-click for agent CLIs
                          </p>
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
                        <TerminalIcon className="h-4 w-4" />
                        {isGrid && <span className="truncate text-xs">New terminal</span>}
                      </Button>
                    </ToolbarContextMenuTrigger>
                    <ContextMenuContent>
                      {enabledAgents.has("claude") && (
                        <ContextMenuItem
                          onClick={() => handleCreateAgentTab("claude", "cli")}
                          disabled={!canCreateTab}
                        >
                          <ClaudeIcon className="mr-2 h-4 w-4" />
                          Claude CLI
                        </ContextMenuItem>
                      )}
                      {enabledAgents.has("codex") && (
                        <ContextMenuItem
                          onClick={() => handleCreateAgentTab("codex", "cli")}
                          disabled={!canCreateTab}
                        >
                          <CodexIcon className="mr-2 h-4 w-4" />
                          Codex CLI
                        </ContextMenuItem>
                      )}
                      {enabledAgents.has("opencode") && (
                        <ContextMenuItem
                          onClick={() => handleCreateAgentTab("opencode", "cli")}
                          disabled={!canCreateTab}
                        >
                          <OpenCodeIcon className="mr-2 h-4 w-4" />
                          OpenCode CLI
                        </ContextMenuItem>
                      )}
                      {enabledAgents.has("grok") && (
                        <ContextMenuItem
                          onClick={() => handleCreateAgentTab("grok", "cli")}
                          disabled={!canCreateTab}
                        >
                          <GrokBuildIcon className="mr-2 h-4 w-4" />
                          Grok CLI
                        </ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>

                  <ToolbarTooltipTrigger
                    tooltip={
                      <>
                        <p>New Root Terminal</p>
                        <p className="text-xs text-red-500">
                          Full root privileges inside container
                        </p>
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

                  <ToolbarTooltipTrigger
                    tooltip={
                      <>
                        <p>New Browser Tab</p>
                        <p className="text-xs text-muted-foreground">
                          {!browserPreviewSupported
                            ? "Available in the desktop app; the web client cannot authenticate previews"
                            : environmentBrowserUrl
                              ? `Open ${environmentBrowserUrl}`
                              : "Preview a service on the backend machine"}
                        </p>
                      </>
                    }
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handleCreateBrowserTab}
                      disabled={!selectedEnvironment || !canCreateTab || !browserPreviewSupported}
                      aria-label="New browser tab"
                    >
                      <Globe2 className="h-4 w-4" />
                      {isGrid && <span className="truncate text-xs">New browser</span>}
                    </Button>
                  </ToolbarTooltipTrigger>

                  <ToolbarTooltipTrigger
                    tooltip={
                      <>
                        <p>Code Review</p>
                        <p className="text-xs text-muted-foreground">
                          Commit changes and review code
                        </p>
                        <p className="text-xs text-muted-foreground">
                          ⌘R · Right-click or long-press to configure
                        </p>
                      </>
                    }
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 touch-manipulation"
                      onClick={(event) => {
                        if (reviewLongPress.shouldSuppressClick()) {
                          event.preventDefault();
                          return;
                        }
                        handleReview();
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        reviewLongPress.cancel();
                        openReviewDialog();
                      }}
                      {...reviewLongPress.handlers}
                      data-toolbar-custom-context-menu="true"
                      disabled={!selectedEnvironment || !canCreateTab}
                      aria-label="Code review"
                    >
                      <Eye className="h-4 w-4" />
                      {isGrid && <span className="truncate text-xs">Code review</span>}
                    </Button>
                  </ToolbarTooltipTrigger>

                  <ToolbarTooltipTrigger
                    tooltip={
                      <>
                        <p>Multi Review</p>
                        <p className="text-xs text-muted-foreground">
                          Compare independent model reviews and consolidate every finding
                        </p>
                      </>
                    }
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setMultiReviewDialogOpen(true)}
                      disabled={
                        !selectedEnvironment ||
                        !canCreateTab ||
                        !isRunning ||
                        !workspaceReady ||
                        setupRunning ||
                        multiReviewLaunchPending
                      }
                      aria-label="Multi Review"
                    >
                      <StackedEyes className="size-4" />
                      {isGrid && <span className="truncate text-xs">Multi Review</span>}
                    </Button>
                  </ToolbarTooltipTrigger>

                  <ToolbarTooltipTrigger
                    tooltip={
                      <>
                        <p>Looped Code Review</p>
                        <p className="text-xs text-muted-foreground">
                          Discover, reconcile, fix, repeat, and create a PR
                        </p>
                      </>
                    }
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setLoopedReviewDialogOpen(true)}
                      disabled={
                        !selectedEnvironment ||
                        !canCreateTab ||
                        !isRunning ||
                        !workspaceReady ||
                        setupRunning ||
                        loopedReviewLaunchPending
                      }
                      aria-label="Looped code review"
                    >
                      <Repeat2 className="h-4 w-4" />
                      {isGrid && <span className="truncate text-xs">Looped review</span>}
                    </Button>
                  </ToolbarTooltipTrigger>

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
                          <p className="text-xs text-muted-foreground">
                            ⌘P · Right-click for script menu
                          </p>
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
                      <ContextMenuItem onClick={handleRun} disabled={!canRunCommands}>
                        <Play className="mr-2 h-4 w-4" />
                        Run Commands
                      </ContextMenuItem>
                      {enabledAgents.has("claude") && (
                        <ContextMenuItem
                          onClick={() => handleCreateScript("claude")}
                          disabled={!canCreateTab || !isRunning}
                        >
                          <FilePlus2 className="mr-2 h-4 w-4" />
                          Create Script with Claude
                        </ContextMenuItem>
                      )}
                      {enabledAgents.has("codex") && (
                        <ContextMenuItem
                          onClick={() => handleCreateScript("codex")}
                          disabled={!canCreateTab || !isRunning}
                        >
                          <FilePlus2 className="mr-2 h-4 w-4" />
                          Create Script with Codex
                        </ContextMenuItem>
                      )}
                      {enabledAgents.has("opencode") && (
                        <ContextMenuItem
                          onClick={() => handleCreateScript("opencode")}
                          disabled={!canCreateTab || !isRunning}
                        >
                          <FilePlus2 className="mr-2 h-4 w-4" />
                          Create Script with OpenCode
                        </ContextMenuItem>
                      )}
                      {enabledAgents.has("cursor") && (
                        <ContextMenuItem
                          onClick={() => handleCreateScript("cursor")}
                          disabled={!canCreateTab || !isRunning}
                        >
                          <FilePlus2 className="mr-2 h-4 w-4" />
                          Create Script with Cursor Agent
                        </ContextMenuItem>
                      )}
                      {enabledAgents.has("grok") && (
                        <ContextMenuItem
                          onClick={() => handleCreateScript("grok")}
                          disabled={!canCreateTab || !isRunning}
                        >
                          <FilePlus2 className="mr-2 h-4 w-4" />
                          Create Script with Grok Build
                        </ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                  <div className={cn("mx-2 h-4 w-px bg-border", isGrid && "hidden")} />

                  <ToolbarTooltipTrigger
                    tooltip={
                      <>
                        <p>
                          Open in{" "}
                          {config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"}
                        </p>
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
                          Open in{" "}
                          {config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"}
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
                        {environmentPortAddress && (
                          <p className="text-xs text-muted-foreground">Ctrl⇧C</p>
                        )}
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
                <ToolbarTooltipTrigger
                  tooltip={
                    !isRunning ? (
                      "Container must be running"
                    ) : !canCreateTab ? (
                      "Maximum tabs reached"
                    ) : (
                      <>
                        <p>Launch agent to create a pull request</p>
                        <p className="text-xs text-muted-foreground">
                          Right-click or long-press to choose agent, model, and reasoning
                        </p>
                      </>
                    )
                  }
                >
                  <Button
                    ref={createPrButtonRef}
                    variant={isGrid ? "ghost" : "default"}
                    size="sm"
                    className="gap-2 touch-manipulation"
                    onClick={(event) => {
                      if (prLongPress.shouldSuppressClick()) {
                        event.preventDefault();
                        return;
                      }
                      handleCreatePR();
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      prLongPress.cancel();
                      openPrDialog();
                    }}
                    {...prLongPress.handlers}
                    data-toolbar-custom-context-menu="true"
                    disabled={!isRunning || !canCreateTab}
                  >
                    <GitPullRequest className="h-4 w-4" />
                    <span className={cn(isGrid && "truncate text-xs")}>Create PR</span>
                  </Button>
                </ToolbarTooltipTrigger>
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
                            ? isLocalEnvironment
                              ? "Environment must be ready"
                              : "Container must be running"
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

                  {!isPRFinished && hasMergeConflicts === null && (
                    <ToolbarTooltipTrigger tooltip="GitHub is still checking whether this PR can be merged">
                      <Button
                        variant={isGrid ? "ghost" : "outline"}
                        size="sm"
                        className="gap-2"
                        disabled
                      >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className={cn(isGrid && "truncate text-xs")}>
                          Checking mergeability…
                        </span>
                      </Button>
                    </ToolbarTooltipTrigger>
                  )}

                  {!isPRFinished && hasMergeConflicts && (
                    <ToolbarTooltipTrigger
                      tooltip={
                        !isRunning ? (
                          isLocalEnvironment ? (
                            "Environment must be ready"
                          ) : (
                            "Container must be running"
                          )
                        ) : !canCreateTab ? (
                          "Maximum tabs reached"
                        ) : (
                          <>
                            <p>PR has merge conflicts - launch agent to resolve them</p>
                            <p className="text-xs text-muted-foreground">
                              Right-click or long-press to choose agent, model, and reasoning
                            </p>
                          </>
                        )
                      }
                    >
                      <Button
                        ref={resolveButtonRef}
                        variant={isGrid ? "ghost" : "destructive"}
                        size="sm"
                        className="gap-2 touch-manipulation"
                        onClick={(event) => {
                          if (resolveLongPress.shouldSuppressClick()) {
                            event.preventDefault();
                            return;
                          }
                          void handleResolveConflicts();
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          resolveLongPress.cancel();
                          openResolveDialog();
                        }}
                        {...resolveLongPress.handlers}
                        data-toolbar-custom-context-menu="true"
                        disabled={!isRunning || !canCreateTab || resolveLaunchInFlight}
                      >
                        <AlertTriangle className="h-4 w-4" />
                        <span className={cn(isGrid && "truncate text-xs")}>Resolve</span>
                      </Button>
                    </ToolbarTooltipTrigger>
                  )}

                  {isPRFinished && (
                    <ToolbarTooltipTrigger
                      tooltip={`Delete this environment (PR is ${isPRMerged ? "merged" : "closed"})`}
                    >
                      <Button
                        variant={isGrid ? "ghost" : "destructive"}
                        size="sm"
                        className="gap-2"
                        disabled={isMerging || isSelectedEnvironmentDeleting}
                        onClick={() => {
                          setCleanupTarget({
                            environmentId: selectedEnvironment.id,
                            environmentName: selectedEnvironment.name,
                            isMerged: isPRMerged,
                          });
                          setCleanupDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        <span className={cn(isGrid && "truncate text-xs")}>Clean Up</span>
                      </Button>
                    </ToolbarTooltipTrigger>
                  )}

                  {!isPRFinished && (
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
                        {enabledAgents.has("claude") && (
                          <ContextMenuItem onClick={() => handlePushChanges("claude")}>
                            <ClaudeIcon className="mr-2 h-4 w-4" />
                            Push with Claude
                          </ContextMenuItem>
                        )}
                        {enabledAgents.has("codex") && (
                          <ContextMenuItem onClick={() => handlePushChanges("codex")}>
                            <CodexIcon className="mr-2 h-4 w-4" />
                            Push with Codex
                          </ContextMenuItem>
                        )}
                        {enabledAgents.has("opencode") && (
                          <ContextMenuItem onClick={() => handlePushChanges("opencode")}>
                            <OpenCodeIcon className="mr-2 h-4 w-4" />
                            Push with OpenCode
                          </ContextMenuItem>
                        )}
                        {enabledAgents.has("cursor") && (
                          <ContextMenuItem onClick={() => handlePushChanges("cursor")}>
                            <CursorAgentIcon className="mr-2 h-4 w-4" />
                            Push with Cursor
                          </ContextMenuItem>
                        )}
                        {enabledAgents.has("grok") && (
                          <ContextMenuItem onClick={() => handlePushChanges("grok")}>
                            <GrokBuildIcon className="mr-2 h-4 w-4" />
                            Push with Grok
                          </ContextMenuItem>
                        )}
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
                isGrid ? "col-span-2 grid grid-cols-2 gap-2" : "flex shrink-0 items-center gap-2",
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
                      projectBoardTab === "github" &&
                        "bg-primary/15 text-blue-300 ring-1 ring-inset ring-primary/50 hover:bg-primary/20 hover:text-blue-200",
                    )}
                    onClick={() => setProjectBoardTab("github")}
                    aria-label="GitHub issues"
                    aria-pressed={projectBoardTab === "github"}
                    disabled={!isProjectBoardView}
                  >
                    <Github className="h-4 w-4" />
                    <span className="truncate text-xs">GitHub issues</span>
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
                      <TabsTrigger
                        value="kanban"
                        className="px-2 text-xs data-[state=active]:!bg-primary/15 data-[state=active]:!text-blue-300 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/50"
                      >
                        Kanban
                      </TabsTrigger>
                      <TabsTrigger
                        value="github"
                        className="px-2 text-xs data-[state=active]:!bg-primary/15 data-[state=active]:!text-blue-300 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/50"
                      >
                        GitHub
                      </TabsTrigger>
                      <TabsTrigger
                        value="linear"
                        className="px-2 text-xs data-[state=active]:!bg-primary/15 data-[state=active]:!text-blue-300 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/50"
                      >
                        Linear
                      </TabsTrigger>
                      <TabsTrigger
                        value="features"
                        className="px-2 text-xs data-[state=active]:!bg-primary/15 data-[state=active]:!text-blue-300 data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/50"
                      >
                        Features
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </>
              ) : !isGrid && !selectedEnvironment ? (
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

      <ReviewLaunchDialog
        open={reviewDialogOpen}
        onOpenChange={setReviewDialogOpen}
        defaultTabType={resolveDefaultReviewTabType({
          defaultAgent: reviewLaunchDefaults.defaultAgent,
          environment: selectedEnvironment ?? undefined,
          global: config.global,
          repositoryConfig: selectedProjectId ? config.repositories[selectedProjectId] : undefined,
        })}
        catalog={reviewModelCatalog}
        preferredModels={reviewLaunchDefaults.preferredModels}
        preferredReasoningEfforts={reviewLaunchDefaults.preferredReasoningEfforts}
        onConfirm={handleConfiguredReview}
      />
      <ReviewLaunchDialog
        kind="looped"
        open={loopedReviewDialogOpen}
        onOpenChange={(open) => {
          if (!loopedReviewLaunchInFlightRef.current) {
            setLoopedReviewDialogOpen(open);
          }
        }}
        defaultTabType={resolveDefaultReviewTabType({
          defaultAgent: reviewLaunchDefaults.defaultAgent,
          environment: selectedEnvironment ?? undefined,
          global: config.global,
          repositoryConfig: selectedProjectId ? config.repositories[selectedProjectId] : undefined,
        })}
        catalog={reviewModelCatalog}
        preferredModels={reviewLaunchDefaults.preferredModels}
        preferredReasoningEfforts={reviewLaunchDefaults.preferredReasoningEfforts}
        busy={loopedReviewLaunchPending}
        onConfirm={handleLoopedReview}
      />
      <MultiReviewLaunchDialog
        open={multiReviewDialogOpen}
        onOpenChange={(open) => {
          if (!multiReviewLaunchInFlightRef.current) setMultiReviewDialogOpen(open);
        }}
        defaultAgent={reviewLaunchDefaults.defaultAgent}
        catalog={reviewModelCatalog}
        preferredModels={reviewLaunchDefaults.preferredModels}
        preferredReasoningEfforts={reviewLaunchDefaults.preferredReasoningEfforts}
        secondReviewerDefaults={review2LaunchDefaults}
        fixModelDefaults={fixReviewIssuesLaunchDefaults}
        busy={multiReviewLaunchPending}
        onConfirm={handleMultiReview}
      />
      <AgentLaunchDialog
        open={prDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPrDialogTarget(null);
            setPrLaunchError(null);
          }
        }}
        defaultAgent={prLaunchDefaults.defaultAgent}
        catalog={reviewModelCatalog}
        enabledAgents={enabledAgentList}
        preferredModels={prLaunchDefaults.preferredModels}
        preferredReasoningEfforts={prLaunchDefaults.preferredReasoningEfforts}
        targetBranch={prDialogTarget?.targetBranch ?? targetBranch}
        returnFocusRef={createPrButtonRef}
        // Below the mobile breakpoint this toolbar lives inside the tools
        // popover, which collapses as the dialog opens. The trigger stays
        // mounted but hidden, so focus has to return to the popover's own
        // trigger; the selector only matches while the popover is closed, which
        // is exactly when the Create PR button is unreachable.
        returnFocusFallback={() =>
          window.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches
            ? document.querySelector<HTMLButtonElement>(MOBILE_TOOLS_TRIGGER_SELECTOR)
            : null
        }
        confirmDisabled={Boolean(prEligibilityError)}
        error={prEligibilityError ?? prLaunchError}
        onConfirm={handleConfiguredCreatePR}
      />
      <AgentLaunchDialog
        kind="resolve-conflicts"
        open={resolveDialogOpen}
        onOpenChange={(open) => {
          // The dialog also refuses dismiss while busy; keep the target so a
          // refused createTab still has a surface after the arm resolves.
          if (!open && resolveLaunchEnvironmentIdRef.current !== null) return;
          if (!open) {
            setResolveDialogTarget(null);
            setResolveLaunchError(null);
          }
        }}
        defaultAgent={resolveLaunchDefaults.defaultAgent}
        catalog={reviewModelCatalog}
        enabledAgents={enabledAgentList}
        preferredModels={resolveLaunchDefaults.preferredModels}
        preferredReasoningEfforts={resolveLaunchDefaults.preferredReasoningEfforts}
        targetBranch={resolveDialogTarget?.targetBranch ?? targetBranch}
        returnFocusRef={resolveButtonRef}
        returnFocusFallback={() =>
          window.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches
            ? document.querySelector<HTMLButtonElement>(MOBILE_TOOLS_TRIGGER_SELECTOR)
            : null
        }
        confirmDisabled={Boolean(resolveEligibilityError)}
        busy={resolveLaunchInFlight}
        error={resolveEligibilityError ?? resolveLaunchError}
        onConfirm={(selection) => void handleConfiguredResolve(selection)}
      />

      {/* Settings Dialogs */}
      {globalSettingsOpen && (
        <LazyLoadBoundary
          loadingFallback={<LazyDialogLoadingFallback label="Loading global settings…" />}
        >
          <LazySettingsPage open={globalSettingsOpen} onOpenChange={setGlobalSettingsOpen} />
        </LazyLoadBoundary>
      )}
      <DockerStatsDialog open={dockerStatsOpen} onOpenChange={setDockerStatsOpen} />

      {repoSettingsProject && (
        <LazyLoadBoundary
          loadingFallback={<LazyDialogLoadingFallback label="Loading repository settings…" />}
        >
          <LazyRepositorySettings
            project={repoSettingsProject}
            open
            onOpenChange={(open) => {
              if (!open) setRepoSettingsProjectId(null);
            }}
            onUpdateProject={updateProject}
          />
        </LazyLoadBoundary>
      )}

      {envSettingsEnvironment && (
        <LazyLoadBoundary
          loadingFallback={<LazyDialogLoadingFallback label="Loading environment settings…" />}
        >
          <LazyEnvironmentSettingsDialog
            open
            onOpenChange={(open) => {
              if (!open) setEnvSettingsEnvironmentId(null);
            }}
            environment={envSettingsEnvironment}
            onUpdate={(updated) => updateEnvironment(updated.id, updated)}
            onRestart={backend.recreateEnvironment}
          />
        </LazyLoadBoundary>
      )}

      {/* Editor Error Dialog */}
      <AlertDialog open={!!editorError} onOpenChange={() => setEditorError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Failed to Open Editor</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>{editorError}</p>
              <p className="text-xs">
                Make sure you have the{" "}
                {config.global.preferredEditor === "cursor" ? "Cursor" : "VS Code"} CLI installed
                and the Dev Containers extension is enabled.
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
          if (!open) {
            setCleanupError(null);
            setCleanupTarget(null);
          }
        }}
      >
        <AlertDialogContent className="max-h-[calc(100vh-2rem)] overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>Clean Up Environment</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the environment "
              {cleanupTarget?.environmentName ?? selectedEnvironment?.name}". The PR has been{" "}
              {cleanupTargetIsMerged ? "merged" : "closed"}, so this environment is no longer
              needed.
              {cleanupTargetIsMerged
                ? " The PR's remote branch will also be deleted if it still exists."
                : ""}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cleanupError && (
            <div className="min-w-0 max-h-[min(16rem,40vh)] overflow-y-auto overflow-x-hidden rounded-md bg-destructive/10 p-3 text-sm text-destructive whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              Failed to delete environment: {cleanupError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCleanupTargetDeleting}>Cancel</AlertDialogCancel>
            <Button
              onClick={handleCleanup}
              disabled={isCleanupTargetDeleting}
              variant="destructive"
            >
              {isCleanupTargetDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete Environment"
              )}
            </Button>
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
              This will squash and merge <span className="font-semibold">{sourceBranch}</span> into{" "}
              <span className="font-semibold">{targetBranch}</span>. If the pull request is a draft,
              it will be marked ready for review first. The feature branch will be deleted after
              merging. Merge &amp; Cleanup also permanently deletes this environment, but only after
              the merge is confirmed successful.
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
              onClick={() => void handleMergePR(false)}
              className="bg-green-600 text-white hover:bg-green-700"
            >
              Merge PR
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => void handleMergePR(true)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Merge &amp; Cleanup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
