import { memo, useState, useId, useRef, type ComponentType, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { DesignEnvironmentDeletionNotice } from "@/components/design/DesignEnvironmentDeletionNotice";
import { PipeIcon } from "@/components/icons/PipeIcon";
import { HoverTooltipContent, useHoverTooltip } from "@/components/ui/hover-tooltip";
import { EnvironmentAgentSummary } from "./EnvironmentAgentSummary";
import { EnvironmentStatusMarker } from "./EnvironmentStatusMarker";
import { EnvironmentTooltipBody } from "./EnvironmentTooltipBody";
import { EnvironmentNameShimmer, EnvironmentNameSignalMarker } from "./EnvironmentNameShimmer";
import { UnreadBellIcon } from "./UnreadBellIcon";
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
import {
  Trash2,
  Play,
  Square,
  Container,
  Laptop,
  Settings2,
  RotateCw,
  Loader2,
  Copy,
  MoreVertical,
} from "lucide-react";
import { toast } from "sonner";
import type { Environment, EnvironmentType } from "@/types";
import { useEnvironmentStore, useEnvironmentDiffStore, useBuildPipelineStore } from "@/stores";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentDisplayActivity } from "@/hooks/useEnvironmentDisplayActivity";
import { resolveEnvironmentAgentActivity } from "@/lib/environment-agent-activity";
import { cn } from "@/lib/utils";
import { getEnvironmentPortAddress } from "@/lib/environment-address";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { useLocalEnvironmentAvailable } from "@/hooks/useLocalEnvironmentAvailable";
import { useEnvironmentChangeProjection } from "@/hooks/useChangeProjection";
import { useEnvironmentPrMergeState } from "@/hooks/useEnvironmentNameSignal";
import { environmentNameSignal } from "@/lib/environment-name-signal";
import { ChangeCountBadge } from "@/components/changes/ChangeCountBadge";
import { FreshnessIndicator } from "@/components/freshness/FreshnessIndicator";
import { hydrationFreshnessNotice } from "@/lib/view-freshness";
import { MachineDot } from "@/components/federation/MachineDot";
import { useFederation } from "@/components/federation/FederationProvider";
import {
  changeLabel,
  changeReason,
  formatFileCount,
  formatLineCount,
  projectionTitle,
} from "@/lib/changes/labels";
import type { ChangeProjection } from "@orkestrator/protocol/change-resources";

export { resolveEnvironmentAgentActivity };

/** Below this width the row shows an explicit actions button; a right-click
 *  context menu is not reachable on touch. Matches Tailwind's `md` breakpoint. */
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * One entry in the environment action list. The same list drives both the
 * desktop context menu and the mobile actions dropdown, so an action added
 * here cannot be missing from one surface.
 */
export type EnvironmentMenuItem =
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
export function EnvironmentMenuItems({
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
        ),
      )}
    </>
  );
}

const APPROXIMATE_MARK = /^[~≥≤]/;

/**
 * The row badge for the environment's `environment-net` projection. Shown
 * only when the backend says so; a stale or partial projection keeps the
 * row's muted `~` idiom (unless the counts already carry their own mark) and
 * explains itself in the tooltip. Another machine's rows use it too.
 */
export function EnvironmentChangeBadge({ projection }: { projection: ChangeProjection }) {
  if (!projection.badge.visible) return null;
  const marked =
    APPROXIMATE_MARK.test(formatLineCount("+", projection.counters.additions)) ||
    APPROXIMATE_MARK.test(formatLineCount("-", projection.counters.deletions));
  const approximate =
    (projection.state === "partial" || projection.state === "stale") &&
    projection.badge.mode === "counts" &&
    !marked;
  return (
    <span
      data-testid="environment-change-badge"
      data-measurement-id={projection.measurementId ?? ""}
      data-change-state={projection.state}
      title={projectionTitle(projection)}
      className="ml-1 flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums"
    >
      {approximate && (
        <span className="text-muted-foreground" aria-hidden="true">
          ~
        </span>
      )}
      <ChangeCountBadge projection={projection} testId="environment-change-counts" />
    </span>
  );
}

/** Hover-card detail for the same projection: files, counts and every backend reason. */
export function EnvironmentChangeSummary({ projection }: { projection: ChangeProjection }) {
  if (!projection.badge.visible) return null;
  const plus = formatLineCount("+", projection.counters.additions);
  const minus = formatLineCount("-", projection.counters.deletions);
  return (
    <div
      className="border-t border-border/50 pt-1 mt-1"
      data-testid="environment-change-summary"
      data-measurement-id={projection.measurementId ?? ""}
    >
      <p className="text-xs text-muted-foreground">
        {changeLabel(projection.labelKey, projection.labelArgs)}:{" "}
        {formatFileCount(projection.counters.changedFiles)} changed
      </p>
      {projection.reasonKeys.map((reason) => (
        <p key={reason} className="text-xs text-muted-foreground">
          {changeReason(reason)}
        </p>
      ))}
      {projection.badge.mode === "counts" && (plus || minus) && (
        <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
          {plus && <span className="text-success">{plus} added</span>}
          {minus && <span className="text-failure">{minus} removed</span>}
        </div>
      )}
    </div>
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
  onFork?: (environmentId: string, environmentType: EnvironmentType) => void;
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
  onFork,
  isMultiSelectMode = false,
  isChecked = false,
  subtitle,
}: EnvironmentItemProps) {
  const dockerAvailable = useDockerAvailability();
  const localEnvironmentAvailable = useLocalEnvironmentAvailable(environment.projectId);
  // The owning machine's colour fills the row's status marker whenever this
  // client can show several machines.
  const { boundMachine: windowMachine, supported: multiMachineClient } = useFederation();
  const boundMachine = multiMachineClient ? windowMachine : null;
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const { displayedActivityState, isRunning } = useEnvironmentDisplayActivity(environment);

  // Check if this environment is being deleted
  const isEnvironmentDeleting = useEnvironmentStore((s) => s.isDeleting(environment.id));
  // Its pull request is ready to merge or blocked by conflicts (pr-merge-readiness).
  const prMergeState = useEnvironmentPrMergeState(environment.id, environment);

  // The badge is the backend's `environment-net` projection — the same
  // measurement the Files → Changes rows page through. Visibility, counts and
  // their quality are backend decisions. An older backend answers no
  // projection; only then does the legacy diff-stat mirror drive the badge.
  const changeProjection = useEnvironmentChangeProjection(environment.id);
  const diffStats = useEnvironmentDiffStore((s) =>
    changeProjection ? undefined : s.stats.get(environment.id),
  );
  // Freshness of the legacy mirror; the projection carries its own quality.
  const diffSyncStatus = useEnvironmentDiffStore((s) =>
    changeProjection ? "current" : s.syncStatus,
  );
  const diffFreshnessNotice = hydrationFreshnessNotice(diffSyncStatus, "change counts");

  // Check if this is a build pipeline environment (O(1) Set lookup, stable reference)
  const isBuildEnvironment = useBuildPipelineStore((s) =>
    s.buildEnvironmentIds.has(environment.id),
  );
  // Backend-owned, so the badge agrees across every connected client.
  const hasUnreadActivity = environment.hasUnreadWork === true;
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  const unreadMail = useAgentMailStore((state) => {
    if (!messagingEnabled) return 0;
    let count = 0;
    for (const mailbox of state.summary.values()) {
      if (mailbox.environmentId === environment.id)
        count += mailbox.userUnseenCount ?? mailbox.unreadCount;
    }
    return count;
  });
  const hasFailedMail = useAgentMailStore(
    (state) =>
      messagingEnabled &&
      Array.from(state.summary.values()).some(
        (mailbox) => mailbox.environmentId === environment.id && mailbox.failedInjectCount > 0,
      ),
  );

  const isLocalEnvironment = environment.environmentType === "local";
  // The project home works in the project's own checkout, not a worktree.
  const isProjectHome = environment.projectHome === true;
  const displayName =
    isProjectHome && environment.name === "project-home" ? "Project home" : environment.name;
  const isCreating = environment.status === "creating";
  const isStopping = environment.status === "stopping";
  // Not applicable to local environments. A settings change that starts a
  // transition reaches this row through the environment store, synchronously.
  const isTransitioning = !isLocalEnvironment && (isCreating || isStopping);
  // Yellow while the agent waits for an answer, else red or green for the PR.
  const nameSignal = isEnvironmentDeleting
    ? null
    : environmentNameSignal({
        waitingOnUser: isRunning && displayedActivityState === "waiting",
        prMergeState,
      });

  const confirmDelete = () => {
    onDelete(environment.id);
    setShowDeleteDialog(false);
  };

  // Get network mode with null safety (defaults to "restricted")

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
      metaKey: e.metaKey || e.ctrlKey,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // For keyboard navigation, we don't have modifier key context
      // Default behavior is simple selection
      handleSelect({
        shiftKey: e.shiftKey,
        metaKey: e.metaKey || e.ctrlKey,
      });
    }
  };

  const localAddress = getEnvironmentPortAddress(environment);
  const initialPrompt = environment.initialPrompt?.trim();

  const copyAddress = () => {
    if (!localAddress) return;
    navigator.clipboard
      .writeText(localAddress)
      .then(() => {
        toast.success("Copied address", { description: localAddress });
      })
      .catch(() => {
        toast.error("Failed to copy address");
      });
  };

  const copyInitialPrompt = () => {
    if (!initialPrompt) return;
    navigator.clipboard
      .writeText(initialPrompt)
      .then(() => {
        toast.success("Initial prompt copied to clipboard");
      })
      .catch(() => {
        toast.error("Failed to copy initial prompt");
      });
  };

  const tooltipAnchorRef = useRef<HTMLDivElement>(null);
  const tooltip = useHoverTooltip();
  // Touch devices have no right-click, so the actions live behind an explicit
  // button there. Gating on the query (rather than a `md:hidden` class) keeps
  // the trigger out of the accessibility tree and the DOM on desktop.
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const environmentNameId = useId();
  const nameSignalDescriptionId = useId();
  const menuItems: EnvironmentMenuItem[] = [
    {
      key: "settings",
      label: "Settings",
      icon: <Settings2 className="h-4 w-4 mr-2" />,
      // The dialog lives in `AppDialogHost`, not in this row: in the mobile
      // projects drawer the row unmounts with the drawer, and a modal opened
      // from inside the drawer would be trapped behind it.
      onSelect: () =>
        useAppDialogStore
          .getState()
          .open({ kind: "environment-settings", environmentId: environment.id }),
    },
    ...(localAddress
      ? [
          {
            key: "copy-address",
            label: "Copy Address",
            icon: <Copy className="h-4 w-4 mr-2" />,
            onSelect: copyAddress,
          },
        ]
      : []),
    ...(initialPrompt
      ? [
          {
            key: "copy-initial-prompt",
            label: "Copy Initial Prompt",
            icon: <Copy className="h-4 w-4 mr-2" />,
            onSelect: copyInitialPrompt,
          },
        ]
      : []),
    { key: "fork-separator", separator: true },
    {
      key: "fork-local",
      label: "Fork local",
      icon: <Laptop className="h-4 w-4 mr-2" />,
      onSelect: () => onFork?.(environment.id, "local"),
      disabled: !localEnvironmentAvailable || isCreating || isEnvironmentDeleting,
    },
    {
      key: "fork-container",
      label: "Fork container",
      icon: <Container className="h-4 w-4 mr-2" />,
      onSelect: () => onFork?.(environment.id, "containerized"),
      disabled: !dockerAvailable || isCreating || isEnvironmentDeleting,
    },
    // Start/Stop/Restart only apply to containerized environments.
    ...(!isLocalEnvironment
      ? ([
          { key: "container-actions", separator: true },
          {
            key: "power",
            label: isRunning ? "Stop" : "Start",
            icon: isRunning ? (
              <Square className="h-4 w-4 mr-2" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            ),
            onSelect: () => (isRunning ? onStop(environment.id) : onStart(environment.id)),
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
              "group flex w-full items-center gap-2 py-1 pr-2 text-[13px] transition-colors",
              // Stops a long-press from starting a text selection on touch.
              isMobile && "select-none",
              isChecked && isMultiSelectMode && "bg-zinc-800/50",
              (isStopping || isEnvironmentDeleting) && "opacity-60",
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
              aria-describedby={nameSignal ? nameSignalDescriptionId : undefined}
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left transition-colors",
                isSelected && !isMultiSelectMode
                  ? "text-foreground"
                  : "text-muted-foreground group-hover:text-foreground",
              )}
            >
              {isEnvironmentDeleting ? (
                // Show red spinner when deleting (priority over multi-select checkbox)
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
              ) : isMultiSelectMode ? null : isTransitioning ? (
                // Show spinner when creating/stopping
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
              ) : (
                <EnvironmentStatusMarker
                  local={isLocalEnvironment}
                  state={isRunning ? displayedActivityState : "inactive"}
                  machine={
                    boundMachine
                      ? {
                          name: boundMachine.name,
                          colorToken: boundMachine.colorToken,
                          status: "This window",
                        }
                      : null
                  }
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <EnvironmentNameShimmer
                    signal={nameSignal}
                    id={environmentNameId}
                    className="truncate font-medium leading-4"
                  >
                    {isBuildEnvironment ? environment.name.replace(/^Build:\s*/, "") : displayName}
                  </EnvironmentNameShimmer>
                  {isBuildEnvironment && (
                    <PipeIcon className="h-3 w-3 shrink-0 translate-y-px text-white" />
                  )}
                  <EnvironmentNameSignalMarker
                    signal={nameSignal}
                    descriptionId={nameSignalDescriptionId}
                  />
                  {boundMachine &&
                    (isEnvironmentDeleting || isMultiSelectMode || isTransitioning) && (
                      <MachineDot
                        machineName={boundMachine.name}
                        colorToken={boundMachine.colorToken}
                        status="This window"
                        shape={isLocalEnvironment ? "circle" : "square"}
                      />
                    )}
                  {hasUnreadActivity && (
                    <UnreadBellIcon className="h-3 w-3" aria-label="New completed activity" />
                  )}
                  {unreadMail > 0 && (
                    <span
                      className="min-w-4 rounded-full bg-cyan-400/90 px-1 text-center font-mono text-[9px] leading-4 text-zinc-950"
                      aria-label={`${unreadMail} unread agent messages`}
                    >
                      {unreadMail > 99 ? "99+" : unreadMail}
                    </span>
                  )}
                  {hasFailedMail && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-amber-400"
                      aria-label="Agent message delivery failed"
                    />
                  )}
                </span>
                {subtitle && (
                  <span className="truncate text-[11px] font-normal leading-4 text-zinc-500">
                    {subtitle}
                  </span>
                )}
              </span>
              {changeProjection ? (
                <EnvironmentChangeBadge projection={changeProjection} />
              ) : (
                diffStats &&
                (diffStats.additions > 0 ||
                  diffStats.deletions > 0 ||
                  diffStats.filesChanged > 0) && (
                  <span
                    className="ml-1 flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums"
                    data-testid="environment-diff-stats"
                  >
                    {diffFreshnessNotice && <FreshnessIndicator notice={diffFreshnessNotice} />}
                    {/* The scan stopped before reading every untracked file, so
                      these are a lower bound rather than an exact count. */}
                    {diffStats.truncated && (
                      <span className="text-muted-foreground" aria-hidden="true">
                        ~
                      </span>
                    )}
                    {diffStats.additions > 0 && (
                      <span className="text-success">+{diffStats.additions}</span>
                    )}
                    {diffStats.deletions > 0 && (
                      <span className="text-failure">-{diffStats.deletions}</span>
                    )}
                    {diffStats.additions === 0 &&
                      diffStats.deletions === 0 &&
                      diffStats.filesChanged > 0 && (
                        <span className="text-muted-foreground">{diffStats.filesChanged}F</span>
                      )}
                  </span>
                )
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
          <EnvironmentTooltipBody
            name={displayName}
            machine={
              boundMachine
                ? {
                    name: boundMachine.name,
                    colorToken: boundMachine.colorToken,
                    status: "this window",
                  }
                : null
            }
            details={environment}
            nameSignal={nameSignal}
            agentSummary={
              <EnvironmentAgentSummary environmentId={environment.id} open={tooltip.open} />
            }
            changes={
              changeProjection ? (
                <EnvironmentChangeSummary projection={changeProjection} />
              ) : (
                diffStats &&
                (diffStats.additions > 0 ||
                  diffStats.deletions > 0 ||
                  diffStats.filesChanged > 0) && (
                  <div className="border-t border-border/50 pt-1 mt-1">
                    <p className="text-xs text-muted-foreground">
                      {diffStats.filesChanged} file{diffStats.filesChanged !== 1 ? "s" : ""} changed
                    </p>
                    {diffStats.truncated && (
                      <p className="text-xs text-muted-foreground">
                        Line counts are approximate: too many untracked files to count them all.
                      </p>
                    )}
                    {diffFreshnessNotice && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        {diffFreshnessNotice.detail}
                      </p>
                    )}
                    <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
                      {diffStats.additions > 0 && (
                        <span className="text-success">+{diffStats.additions} added</span>
                      )}
                      {diffStats.deletions > 0 && (
                        <span className="text-failure">-{diffStats.deletions} removed</span>
                      )}
                    </div>
                  </div>
                )
              )
            }
            onCopyAddress={copyAddress}
          />
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
              Are you sure you want to delete <strong>{displayName}</strong>?
              {isProjectHome ? (
                <span className="block mt-2">
                  Only Orkestrator&apos;s sessions for it are removed. Your project checkout, its
                  files and its branch are not touched.
                </span>
              ) : isLocalEnvironment ? (
                <span className="block mt-2 text-orange-500">
                  This will delete the git worktree from your machine.
                </span>
              ) : (
                <>
                  <span className="block mt-2">
                    Its container, persistent storage and any recovery copies kept from earlier
                    rebuilds are deleted with it.
                  </span>
                  {isRunning && (
                    <span className="block mt-2 text-orange-500">
                      Warning: This environment is currently running. It will be stopped before
                      deletion.
                    </span>
                  )}
                </>
              )}
              {environment.prUrl && (
                <span className="block mt-2">
                  This environment has an associated PR that will remain open.
                </span>
              )}
              <DesignEnvironmentDeletionNotice
                environmentId={environment.id}
                open={showDeleteDialog}
              />
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
    </>
  );
});
