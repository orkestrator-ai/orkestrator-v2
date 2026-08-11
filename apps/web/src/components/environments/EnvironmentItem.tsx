import { lazy, memo, useState, useEffect, useId, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
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
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bell, Trash2, Play, Square, Container, Laptop, Shield, Globe, Settings2, RotateCw, Loader2, Network, Copy, MoreVertical } from "lucide-react";
import { toast } from "sonner";
import type { AgentActivityState, Environment } from "@/types";
import { useEnvironmentStore, useEnvironmentDiffStore, useBuildPipelineStore } from "@/stores";
import {
  parseUsableAgentActivityTime,
  useAgentActivityStore,
} from "@/stores/agentActivityStore";
import { cn } from "@/lib/utils";
import * as backend from "@/lib/backend";
import { getEnvironmentPortAddress } from "@/lib/environment-address";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  LazyDialogLoadingFallback,
  LazyLoadBoundary,
} from "@/components/LazyLoadBoundary";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";

const LazyEnvironmentSettingsDialog = lazy(async () => ({
  default: (await import("./EnvironmentSettingsDialog")).EnvironmentSettingsDialog,
}));

/** Below this width the row shows an explicit actions button; a right-click
 *  context menu is not reachable on touch. Matches Tailwind's `md` breakpoint. */
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

function activityTime(value: string | undefined): number {
  return parseUsableAgentActivityTime(value);
}

/**
 * Selects the freshest activity observation. Runtime events keep the current
 * frontend responsive, while the persisted environment snapshot hydrates a
 * frontend that never saw those events (or was suspended while they fired).
 */
export function resolveEnvironmentAgentActivity(
  environment: Environment,
  runtimeStates: Record<string, AgentActivityState>,
  runtimeUpdatedAt: Record<string, string>,
): AgentActivityState {
  const runtimeKeys = [
    environment.id,
    ...(environment.containerId ? [environment.containerId] : []),
  ];
  let runtimeState: AgentActivityState | undefined;
  let runtimeTime = Number.NEGATIVE_INFINITY;
  for (const key of runtimeKeys) {
    const candidate = runtimeStates[key];
    if (!candidate) continue;
    const candidateTime = activityTime(runtimeUpdatedAt[key]);
    if (!Number.isFinite(candidateTime)) continue;
    if (!runtimeState || candidateTime > runtimeTime) {
      runtimeState = candidate;
      runtimeTime = candidateTime;
    }
  }

  const persistedState = environment.agentActivityState;
  const persistedTime = activityTime(environment.agentActivityUpdatedAt);
  if (
    persistedState
    && Number.isFinite(persistedTime)
    && (!runtimeState || persistedTime >= runtimeTime)
  ) {
    return persistedState;
  }
  return runtimeState ?? "idle";
}

/**
 * One entry in the environment action list. The same list drives both the
 * desktop context menu and the mobile actions dropdown, so an action added
 * here cannot be missing from one surface.
 */
type EnvironmentMenuItem =
  | { key: string; separator: true }
  | {
      key: string;
      separator?: undefined;
      label: string;
      icon: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      variant?: "destructive";
    };

type MenuItemComponent = ComponentType<{
  children?: ReactNode;
  variant?: "default" | "destructive";
  disabled?: boolean;
  /** Radix only fires `onSelect` when the item is enabled; a plain `onClick`
   *  would still run on a disabled item wherever CSS is not applied. */
  onSelect?: () => void;
}>;

type MenuSeparatorComponent = ComponentType<Record<never, never>>;

/** Renders `items` with whichever menu primitive the calling surface uses. */
function EnvironmentMenuItems({
  items,
  Item,
  Separator,
}: {
  items: EnvironmentMenuItem[];
  Item: MenuItemComponent;
  Separator: MenuSeparatorComponent;
}) {
  return (
    <>
      {items.map((item) =>
        item.separator ? (
          <Separator key={item.key} />
        ) : (
          <Item
            key={item.key}
            variant={item.variant}
            disabled={item.disabled}
            onSelect={item.onSelect}
          >
            {item.icon}
            {item.label}
          </Item>
        )
      )}
    </>
  );
}

interface EnvironmentItemProps {
  environment: Environment;
  isSelected: boolean;
  onSelect: (environmentId: string, modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  onDelete: (environmentId: string) => void;
  onStart: (environmentId: string) => void;
  onStop: (environmentId: string) => void;
  onRestart: (environmentId: string) => void;
  onUpdate?: (environment: Environment) => void;
  isMultiSelectMode?: boolean;
  isChecked?: boolean;
  /** Optional secondary label used by the flat activity view. */
  subtitle?: string;
}

export const EnvironmentItem = memo(function EnvironmentItem({
  environment,
  isSelected,
  onSelect,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onUpdate,
  isMultiSelectMode = false,
  isChecked = false,
  subtitle,
}: EnvironmentItemProps) {
  const dockerAvailable = useDockerAvailability();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  // Local state to track transitioning - ensures spinner shows immediately
  const [isLocalTransitioning, setIsLocalTransitioning] = useState(false);

  // Get Claude activity state for this environment
  // For terminal-based Claude, state is keyed by containerId
  // For native Claude mode, state is keyed by environmentId.
  // Resolved inside the selector so this row only rerenders when ITS resolved
  // state changes, not whenever any environment's activity record is touched.
  const agentActivityState = useAgentActivityStore((s) =>
    resolveEnvironmentAgentActivity(
      environment,
      s.containerStates,
      s.containerStateUpdatedAt,
    ),
  );

  // Check if this environment is being deleted
  const isEnvironmentDeleting = useEnvironmentStore((s) => s.isDeleting(environment.id));

  // Get diff stats for this environment
  const diffStats = useEnvironmentDiffStore((s) => s.stats.get(environment.id));

  // Check if this is a build pipeline environment (O(1) Set lookup, stable reference)
  const isBuildEnvironment = useBuildPipelineStore((s) => s.buildEnvironmentIds.has(environment.id));
  // Backend-owned, so the badge agrees across every connected client.
  const hasUnreadActivity = environment.hasUnreadWork === true;

  const isLocalEnvironment = environment.environmentType === "local";
  // Local environments are always considered "running" - they exist or they don't
  const isRunning = isLocalEnvironment || (dockerAvailable && environment.status === "running");
  const isCreating = environment.status === "creating";
  const isStopping = environment.status === "stopping";
  // Use local state OR prop status for transitioning (not applicable for local environments)
  const isTransitioning = !isLocalEnvironment && (isLocalTransitioning || isCreating || isStopping);

  // Clear local transitioning state when environment status changes to non-transitioning
  useEffect(() => {
    if (!isCreating && !isStopping) {
      setIsLocalTransitioning(false);
    }
  }, [environment.status, isCreating, isStopping]);

  const confirmDelete = () => {
    onDelete(environment.id);
    setShowDeleteDialog(false);
  };

  const handleEnvironmentUpdate = (updated: Environment) => {
    // Set local transitioning state for immediate spinner feedback
    if (updated.status === "creating" || updated.status === "stopping") {
      setIsLocalTransitioning(true);
    } else {
      setIsLocalTransitioning(false);
    }
    onUpdate?.(updated);
  };

  // Get network mode with null safety (defaults to "restricted")
  const networkMode = environment.networkAccessMode ?? "restricted";

  const handleCheckboxChange = () => {
    // Toggle individual item selection (Cmd/Ctrl+Click behavior)
    onSelect(environment.id, { metaKey: true });
  };

  const handleSelect = (modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => {
    onSelect(environment.id, modifiers);
  };

  const handleClick = (e: React.MouseEvent) => {
    // Pass modifier key states to parent for multi-select handling
    // metaKey covers Cmd on Mac, ctrlKey covers Ctrl on Windows/Linux
    handleSelect({
      shiftKey: e.shiftKey,
      metaKey: e.metaKey || e.ctrlKey
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // For keyboard navigation, we don't have modifier key context
      // Default behavior is simple selection
      handleSelect({
        shiftKey: e.shiftKey,
        metaKey: e.metaKey || e.ctrlKey
      });
    }
  };

  const localAddress = getEnvironmentPortAddress(environment);
  const initialPrompt = environment.initialPrompt?.trim();

  const copyAddress = () => {
    if (!localAddress) return;
    navigator.clipboard.writeText(localAddress).then(() => {
      toast.success("Copied address", { description: localAddress });
    }).catch(() => {
      toast.error("Failed to copy address");
    });
  };

  const copyInitialPrompt = () => {
    if (!initialPrompt) return;
    navigator.clipboard.writeText(initialPrompt).then(() => {
      toast.success("Initial prompt copied to clipboard");
    }).catch(() => {
      toast.error("Failed to copy initial prompt");
    });
  };

  const createdDate = useMemo(
    () => new Date(environment.createdAt).toLocaleDateString(),
    [environment.createdAt],
  );
  const tooltipAnchorRef = useRef<HTMLDivElement>(null);
  const tooltip = useHoverTooltip();
  // Touch devices have no right-click, so the actions live behind an explicit
  // button there. Gating on the query (rather than a `md:hidden` class) keeps
  // the trigger out of the accessibility tree and the DOM on desktop.
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const environmentNameId = useId();
  const menuItems: EnvironmentMenuItem[] = [
    {
      key: "settings",
      label: "Settings",
      icon: <Settings2 className="h-4 w-4 mr-2" />,
      onSelect: () => setShowSettingsDialog(true),
    },
    ...(localAddress
      ? [{
          key: "copy-address",
          label: "Copy Address",
          icon: <Copy className="h-4 w-4 mr-2" />,
          onSelect: copyAddress,
        }]
      : []),
    ...(initialPrompt
      ? [{
          key: "copy-initial-prompt",
          label: "Copy Initial Prompt",
          icon: <Copy className="h-4 w-4 mr-2" />,
          onSelect: copyInitialPrompt,
        }]
      : []),
    // Start/Stop/Restart only apply to containerized environments.
    ...(!isLocalEnvironment
      ? ([
          { key: "container-actions", separator: true },
          {
            key: "power",
            label: isRunning ? "Stop" : "Start",
            icon: isRunning
              ? <Square className="h-4 w-4 mr-2" />
              : <Play className="h-4 w-4 mr-2" />,
            onSelect: () => isRunning ? onStop(environment.id) : onStart(environment.id),
            disabled: !dockerAvailable || isTransitioning,
          },
          {
            key: "restart",
            label: "Restart",
            icon: <RotateCw className="h-4 w-4 mr-2" />,
            onSelect: () => onRestart(environment.id),
            disabled: !dockerAvailable || !isRunning || isTransitioning,
          },
        ] satisfies EnvironmentMenuItem[])
      : []),
    { key: "delete-separator", separator: true },
    {
      key: "delete",
      label: "Delete",
      icon: <Trash2 className="h-4 w-4 mr-2" />,
      onSelect: () => setShowDeleteDialog(true),
      variant: "destructive",
    },
  ];

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          {/* Row container. Deliberately NOT the button: the checkbox and the
              actions trigger are siblings of the selectable region, because
              ARIA treats the children of `role="button"` as presentational and
              would hide any control nested inside it from assistive tech. */}
          <div
            ref={tooltipAnchorRef}
            className={cn(
              "group flex w-full items-center gap-2 py-1.5 pr-2 text-[13px] transition-colors",
              // Stops a long-press from starting a text selection on touch.
              isMobile && "select-none",
              subtitle && "py-2",
              isChecked && isMultiSelectMode && "bg-zinc-800/50",
              (isStopping || isEnvironmentDeleting) && "opacity-60"
            )}
          >
            {/* A deleting environment shows its spinner instead of a checkbox:
                there is nothing useful left to select. */}
            {isMultiSelectMode && !isEnvironmentDeleting && (
              <Checkbox
                checked={isChecked}
                onCheckedChange={handleCheckboxChange}
                className="h-4 w-4 shrink-0"
              />
            )}
            <div
              role="button"
              tabIndex={0}
              onClick={handleClick}
              onKeyDown={handleKeyDown}
              onMouseEnter={tooltip.show}
              onMouseLeave={tooltip.hide}
              onFocus={tooltip.show}
              onBlur={tooltip.hide}
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left transition-colors",
                isSelected && !isMultiSelectMode
                  ? "text-foreground"
                  : "text-muted-foreground group-hover:text-foreground"
              )}
            >
              {isEnvironmentDeleting ? (
                // Show red spinner when deleting (priority over multi-select checkbox)
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
              ) : isMultiSelectMode ? null : isTransitioning ? (
                // Show spinner when creating/stopping
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
              ) : (
                // Show Laptop for local environments, Container for containerized
                environment.environmentType === "local" ? (
                  <Laptop className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    !isRunning && "text-muted-foreground",
                    isRunning && agentActivityState === "waiting" && "text-amber-500 animate-pulse",
                    isRunning && agentActivityState === "working" && "text-blue-500 animate-pulse",
                    isRunning && agentActivityState === "idle" && "text-green-500"
                  )} />
                ) : (
                  <Container className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    !isRunning && "text-muted-foreground",
                    isRunning && agentActivityState === "waiting" && "text-amber-500 animate-pulse",
                    isRunning && agentActivityState === "working" && "text-blue-500 animate-pulse",
                    isRunning && agentActivityState === "idle" && "text-green-500"
                  )} />
                )
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    id={environmentNameId}
                    className={cn("truncate font-medium leading-4", isBuildEnvironment && "text-yellow-400")}
                  >
                    {isBuildEnvironment ? environment.name.replace(/^Build:\s*/, "") : environment.name}
                  </span>
                  {hasUnreadActivity && (
                    <Bell
                      className="h-3 w-3 shrink-0 fill-amber-400/20 text-amber-400"
                      aria-label="New completed activity"
                    />
                  )}
                </span>
                {subtitle && (
                  <span className="truncate text-[11px] font-normal leading-4 text-zinc-500">
                    {subtitle}
                  </span>
                )}
              </span>
              {diffStats && (diffStats.additions > 0 || diffStats.deletions > 0 || diffStats.filesChanged > 0) && (
                <span className="ml-1 flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
                  {/* The scan stopped before reading every untracked file, so
                      these are a lower bound rather than an exact count. */}
                  {diffStats.truncated && (
                    <span className="text-muted-foreground" aria-hidden="true">~</span>
                  )}
                  {diffStats.additions > 0 && (
                    <span className="text-green-500">+{diffStats.additions}</span>
                  )}
                  {diffStats.deletions > 0 && (
                    <span className="text-red-400">-{diffStats.deletions}</span>
                  )}
                  {diffStats.additions === 0 && diffStats.deletions === 0 && diffStats.filesChanged > 0 && (
                    <span className="text-muted-foreground">{diffStats.filesChanged}F</span>
                  )}
                </span>
              )}
            </div>
            {isMobile && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="-my-1 -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-700/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    // The label stays generic and the row name is attached as a
                    // description: folding the name into the label would make
                    // every "<name>" role+name query in the app ambiguous.
                    aria-label="Environment actions"
                    aria-describedby={environmentNameId}
                    // Radix's ContextMenu opens on a touch long-press anywhere
                    // inside its trigger, which includes this button. Without
                    // this the long-press timer races the dropdown open.
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <MoreVertical className="h-4 w-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <EnvironmentMenuItems
                    items={menuItems}
                    Item={DropdownMenuItem}
                    Separator={DropdownMenuSeparator}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </ContextMenuTrigger>
        <HoverTooltipContent
          anchorRef={tooltipAnchorRef}
          open={tooltip.open}
          side="bottom"
          align="start"
          sideOffset={4}
          onMouseEnter={tooltip.show}
          onMouseLeave={tooltip.hide}
        >
            <div className="space-y-1">
              <p className="font-medium">{environment.name}</p>
              <p className="text-xs text-muted-foreground">Created: {createdDate}</p>
              {isLocalEnvironment ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Laptop className="h-3 w-3" />
                  Local worktree
                </p>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  {networkMode === "full" ? (
                    <>
                      <Globe className="h-3 w-3" />
                      Full network access
                    </>
                  ) : (
                    <>
                      <Shield className="h-3 w-3" />
                      Restricted network
                    </>
                  )}
                </p>
              )}
              {!isLocalEnvironment && environment.entryPort && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Network className="h-3 w-3" />
                  {environment.hostEntryPort
                    ? <>Port: <span
                        role="button"
                        className="underline decoration-dotted cursor-pointer hover:text-foreground transition-colors"
                        onClick={(e) => { e.stopPropagation(); copyAddress(); }}
                      >localhost:{environment.hostEntryPort}</span> → {environment.entryPort}/tcp</>
                    : <>Port: {environment.entryPort}/tcp (not mapped)</>
                  }
                </p>
              )}
              {diffStats && (diffStats.additions > 0 || diffStats.deletions > 0 || diffStats.filesChanged > 0) && (
                <div className="border-t border-border/50 pt-1 mt-1">
                  <p className="text-xs text-muted-foreground">
                    {diffStats.filesChanged} file{diffStats.filesChanged !== 1 ? "s" : ""} changed
                  </p>
                  {diffStats.truncated && (
                    <p className="text-xs text-muted-foreground">
                      Line counts are approximate: too many untracked files to count them all.
                    </p>
                  )}
                  <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
                    {diffStats.additions > 0 && (
                      <span className="text-green-500">+{diffStats.additions} added</span>
                    )}
                    {diffStats.deletions > 0 && (
                      <span className="text-red-400">-{diffStats.deletions} removed</span>
                    )}
                  </div>
                </div>
              )}
              {environment.prUrl && (
                <p className="text-xs text-blue-400">PR: {environment.prUrl}</p>
              )}
            </div>
        </HoverTooltipContent>
        <ContextMenuContent>
          <EnvironmentMenuItems
            items={menuItems}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
          />
        </ContextMenuContent>
      </ContextMenu>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Environment</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{environment.name}</strong>?
              {isLocalEnvironment ? (
                <span className="block mt-2 text-orange-500">
                  This will delete the git worktree from your machine.
                </span>
              ) : (
                isRunning && (
                  <span className="block mt-2 text-orange-500">
                    Warning: This environment is currently running. It will be stopped before deletion.
                  </span>
                )
              )}
              {environment.prUrl && (
                <span className="block mt-2">
                  This environment has an associated PR that will remain open.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Environment Settings Dialog — mounted only while open so a sidebar
          with many rows does not pay for a dialog per row. */}
      {showSettingsDialog && (
        <LazyLoadBoundary
          loadingFallback={
            <LazyDialogLoadingFallback label="Loading environment settings…" />
          }
        >
          <LazyEnvironmentSettingsDialog
            open={showSettingsDialog}
            onOpenChange={setShowSettingsDialog}
            environment={environment}
            onUpdate={handleEnvironmentUpdate}
            onRestart={backend.recreateEnvironment}
          />
        </LazyLoadBoundary>
      )}
    </>
  );
});
