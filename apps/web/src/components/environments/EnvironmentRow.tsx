import { useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  Container,
  Copy,
  Laptop,
  Link2,
  Loader2,
  MoreVertical,
  PanelRight,
  Play,
  RotateCw,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import type { ChangeProjection } from "@orkestrator/protocol/change-resources";
import type { EnvironmentDiffStats } from "@orkestrator/protocol/diff-stats";
import { Checkbox } from "@/components/ui/checkbox";
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
import { HoverTooltipContent, type useHoverTooltip } from "@/components/ui/hover-tooltip";
import { ChangeCountBadge } from "@/components/changes/ChangeCountBadge";
import { FreshnessIndicator } from "@/components/freshness/FreshnessIndicator";
import { MachineDot } from "@/components/federation/MachineDot";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  changeLabel,
  changeReason,
  formatFileCount,
  formatLineCount,
  projectionTitle,
} from "@/lib/changes/labels";
import { cn } from "@/lib/utils";
import type { FreshnessNotice } from "@/lib/view-freshness";
import type { EnvironmentType } from "@/types";
import { EnvironmentDeleteDialog } from "./EnvironmentDeleteDialog";
import { EnvironmentNameIcons } from "./EnvironmentNameIcons";
import { EnvironmentNameShimmer, EnvironmentNameSignalMarker } from "./EnvironmentNameShimmer";
import { EnvironmentStatusMarker } from "./EnvironmentStatusMarker";
import { EnvironmentTooltipBody, type EnvironmentTooltipDetails } from "./EnvironmentTooltipBody";
import { UnreadBellIcon } from "./UnreadBellIcon";
import {
  environmentRowModel,
  type EnvironmentRowFacts,
  type EnvironmentRowModel,
} from "./environment-row-model";

/** Below this width the row shows an explicit actions button; a right-click
 *  context menu is not reachable on touch. Matches Tailwind's `md` breakpoint. */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

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
 * explains itself in the tooltip.
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

/**
 * What the row says about uncommitted changes: the backend's projection, or,
 * from a backend that answers none, the legacy diff-stat mirror.
 */
export type EnvironmentRowChanges =
  | { kind: "projection"; projection: ChangeProjection }
  | { kind: "legacy"; stats: EnvironmentDiffStats; freshness: FreshnessNotice | null };

function hasLegacyChanges(stats: EnvironmentDiffStats): boolean {
  return stats.additions > 0 || stats.deletions > 0 || stats.filesChanged > 0;
}

function RowChangeBadge({ changes }: { changes: EnvironmentRowChanges }) {
  if (changes.kind === "projection")
    return <EnvironmentChangeBadge projection={changes.projection} />;
  const { stats, freshness } = changes;
  if (!hasLegacyChanges(stats)) return null;
  return (
    <span
      className="ml-1 flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums"
      data-testid="environment-diff-stats"
    >
      {freshness && <FreshnessIndicator notice={freshness} />}
      {/* The scan stopped before reading every untracked file, so these are a
          lower bound rather than an exact count. */}
      {stats.truncated && (
        <span className="text-muted-foreground" aria-hidden="true">
          ~
        </span>
      )}
      {stats.additions > 0 && <span className="text-success">+{stats.additions}</span>}
      {stats.deletions > 0 && <span className="text-failure">-{stats.deletions}</span>}
      {stats.additions === 0 && stats.deletions === 0 && stats.filesChanged > 0 && (
        <span className="text-muted-foreground">{stats.filesChanged}F</span>
      )}
    </span>
  );
}

function RowChangeSummary({ changes }: { changes: EnvironmentRowChanges }) {
  if (changes.kind === "projection") {
    return <EnvironmentChangeSummary projection={changes.projection} />;
  }
  const { stats, freshness } = changes;
  if (!hasLegacyChanges(stats)) return null;
  return (
    <div className="border-t border-border/50 pt-1 mt-1">
      <p className="text-xs text-muted-foreground">
        {stats.filesChanged} file{stats.filesChanged !== 1 ? "s" : ""} changed
      </p>
      {stats.truncated && (
        <p className="text-xs text-muted-foreground">
          Line counts are approximate: too many untracked files to count them all.
        </p>
      )}
      {freshness && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{freshness.detail}</p>
      )}
      <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
        {stats.additions > 0 && <span className="text-success">+{stats.additions} added</span>}
        {stats.deletions > 0 && <span className="text-failure">-{stats.deletions} removed</span>}
      </div>
    </div>
  );
}

/** What a row can do. Optional entries appear only where they apply. */
export interface EnvironmentRowActions {
  /** "Open workspace": another machine's row opens that machine's workspace. */
  open?: () => void;
  /** A machine-qualified link to the environment. */
  copyLink?: () => void;
  openSettings: () => void;
  /** Present when the environment publishes a host address. */
  copyAddress?: () => void;
  /** Present when the environment has an initial prompt this client can read. */
  copyInitialPrompt?: () => void;
  fork: (environmentType: EnvironmentType) => void;
  start: () => void;
  stop: () => void;
  restart: () => void;
  /** Runs the deletion once the row's confirmation is accepted. */
  confirmDelete: () => void;
}

/** The row's action list, the same for every row; disabled states come from the model. */
export function environmentRowMenuItems(
  model: EnvironmentRowModel,
  actions: EnvironmentRowActions,
  requestDelete: () => void,
): EnvironmentMenuItem[] {
  const icon = "h-4 w-4 mr-2";
  return [
    ...(actions.open
      ? [
          {
            key: "open",
            label: "Open workspace",
            icon: <PanelRight className={icon} />,
            onSelect: actions.open,
          },
        ]
      : []),
    ...(actions.copyLink
      ? [
          {
            key: "copy-link",
            label: "Copy link",
            icon: <Link2 className={icon} />,
            onSelect: actions.copyLink,
          },
        ]
      : []),
    {
      key: "settings",
      label: "Settings",
      icon: <Settings2 className={icon} />,
      onSelect: actions.openSettings,
      disabled: model.menu.settingsDisabled,
    },
    ...(actions.copyAddress
      ? [
          {
            key: "copy-address",
            label: "Copy Address",
            icon: <Copy className={icon} />,
            onSelect: actions.copyAddress,
          },
        ]
      : []),
    ...(actions.copyInitialPrompt
      ? [
          {
            key: "copy-initial-prompt",
            label: "Copy Initial Prompt",
            icon: <Copy className={icon} />,
            onSelect: actions.copyInitialPrompt,
          },
        ]
      : []),
    { key: "fork-separator", separator: true },
    {
      key: "fork-local",
      label: "Fork local",
      icon: <Laptop className={icon} />,
      onSelect: () => actions.fork("local"),
      disabled: model.menu.forkLocalDisabled,
    },
    {
      key: "fork-container",
      label: "Fork container",
      icon: <Container className={icon} />,
      onSelect: () => actions.fork("containerized"),
      disabled: model.menu.forkContainerDisabled,
    },
    // Start/Stop/Restart only apply to containerized environments.
    ...(!model.isLocal
      ? ([
          { key: "container-actions", separator: true },
          {
            key: "power",
            label: model.isRunning ? "Stop" : "Start",
            icon: model.isRunning ? <Square className={icon} /> : <Play className={icon} />,
            onSelect: model.isRunning ? actions.stop : actions.start,
            disabled: model.menu.powerDisabled,
          },
          {
            key: "restart",
            label: "Restart",
            icon: <RotateCw className={icon} />,
            onSelect: actions.restart,
            disabled: model.menu.restartDisabled,
          },
        ] satisfies EnvironmentMenuItem[])
      : []),
    { key: "delete-separator", separator: true },
    {
      key: "delete",
      label: "Delete",
      icon: <Trash2 className={icon} />,
      onSelect: requestDelete,
      disabled: model.menu.deleteDisabled,
      variant: "destructive",
    },
  ];
}

export interface EnvironmentRowProps {
  facts: EnvironmentRowFacts;
  selected: boolean;
  /** Secondary line, e.g. the project name in the activity list. */
  subtitle?: string;
  /** This window's multi-select; another machine's rows take no part in it. */
  multiSelect?: { active: boolean; checked: boolean; onToggle: () => void };
  /** Click or Enter/Space on the row. */
  onActivate: (modifiers: { shiftKey: boolean; metaKey: boolean }) => void;
  actions: EnvironmentRowActions;
  changes: EnvironmentRowChanges | null;
  /** The adapter owns it, so it can read details only while the card is open. */
  tooltip: ReturnType<typeof useHoverTooltip>;
  tooltipDetails: EnvironmentTooltipDetails;
  agentSummary: ReactNode;
  /** Extra notes for the delete confirmation, rendered while it is open. */
  deleteNotice?: (open: boolean) => ReactNode;
}

/**
 * One environment row, for this window's machine and every other machine
 * alike. Everything it shows comes from `environmentRowModel(facts)`; the
 * adapters (`EnvironmentItem`, `RemoteEnvironmentItem`) only gather facts and
 * actions.
 */
export function EnvironmentRow({
  facts,
  selected,
  subtitle,
  multiSelect,
  onActivate,
  actions,
  changes,
  tooltip,
  tooltipDetails,
  agentSummary,
  deleteNotice,
}: EnvironmentRowProps) {
  const model = environmentRowModel(facts);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const tooltipAnchorRef = useRef<HTMLDivElement>(null);
  // Touch devices have no right-click, so the actions live behind an explicit
  // button there. Gating on the query (rather than a `md:hidden` class) keeps
  // the trigger out of the accessibility tree and the DOM on desktop.
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const nameId = useId();
  const signalDescriptionId = useId();
  const multiSelectActive = multiSelect?.active === true;
  const menuItems = environmentRowMenuItems(model, actions, () => setDeleteOpen(true));

  const activate = (event: React.MouseEvent | React.KeyboardEvent) =>
    // metaKey covers Cmd on Mac, ctrlKey covers Ctrl on Windows/Linux.
    onActivate({ shiftKey: event.shiftKey, metaKey: event.metaKey || event.ctrlKey });

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
              multiSelect?.checked && multiSelectActive && "bg-zinc-800/50",
              model.dimmed && "opacity-60",
            )}
          >
            {/* A deleting environment shows its spinner instead of a checkbox:
                there is nothing useful left to select. */}
            {multiSelectActive && !facts.deleting && (
              <Checkbox
                checked={multiSelect.checked}
                onCheckedChange={multiSelect.onToggle}
                className="h-4 w-4 shrink-0"
              />
            )}
            <div
              role="button"
              tabIndex={0}
              onClick={activate}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activate(event);
                }
              }}
              onMouseEnter={tooltip.show}
              onMouseLeave={tooltip.hide}
              onFocus={tooltip.show}
              onBlur={tooltip.hide}
              aria-label={model.accessibleLabel}
              aria-describedby={model.nameSignal ? signalDescriptionId : undefined}
              aria-current={selected && !multiSelectActive ? "true" : undefined}
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left transition-colors",
                selected && !multiSelectActive
                  ? "text-foreground"
                  : "text-muted-foreground group-hover:text-foreground",
              )}
            >
              {model.spinner === "deleting" ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
              ) : multiSelectActive ? null : model.spinner === "transition" ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
              ) : (
                <EnvironmentStatusMarker
                  local={model.isLocal}
                  state={model.markerState}
                  machine={model.markerMachine}
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <EnvironmentNameShimmer
                    signal={model.nameSignal}
                    id={nameId}
                    className="truncate font-medium leading-4"
                  >
                    {model.rowName}
                  </EnvironmentNameShimmer>
                  <EnvironmentNameIcons
                    buildPipeline={facts.buildPipeline}
                    prState={facts.prState}
                    autoMerge={facts.autoMerge}
                  />
                  <EnvironmentNameSignalMarker
                    signal={model.nameSignal}
                    descriptionId={signalDescriptionId}
                  />
                  {model.markerMachine &&
                    (facts.deleting || multiSelectActive || model.spinner === "transition") && (
                      <MachineDot
                        machineName={model.markerMachine.name}
                        colorToken={model.markerMachine.colorToken}
                        status={model.markerMachine.status}
                        shape={model.isLocal ? "circle" : "square"}
                      />
                    )}
                  {facts.hasUnreadWork && (
                    <UnreadBellIcon className="h-3 w-3" aria-label="New completed activity" />
                  )}
                  {facts.unreadMail > 0 && (
                    <span
                      className="min-w-4 rounded-full bg-cyan-400/90 px-1 text-center font-mono text-[9px] leading-4 text-zinc-950"
                      aria-label={`${facts.unreadMail} unread agent messages`}
                    >
                      {facts.unreadMail > 99 ? "99+" : facts.unreadMail}
                    </span>
                  )}
                  {facts.failedMail && (
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
              {changes && (
                // Last known while the machine is away.
                <span className={cn("contents", !facts.live && "[&>*]:opacity-60")}>
                  <RowChangeBadge changes={changes} />
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
                    aria-describedby={nameId}
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
            name={model.displayName}
            machine={model.cardMachine}
            details={tooltipDetails}
            nameSignal={model.nameSignal}
            agentSummary={agentSummary}
            changes={changes ? <RowChangeSummary changes={changes} /> : null}
            onCopyAddress={actions.copyAddress}
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
      <EnvironmentDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => {
          setDeleteOpen(false);
          actions.confirmDelete();
        }}
        name={model.displayName}
        machineName={facts.machine?.name ?? null}
        projectHome={model.isProjectHome}
        local={model.isLocal}
        running={model.isRunning}
        hasPullRequest={Boolean(tooltipDetails.prUrl)}
        notice={deleteNotice?.(deleteOpen)}
      />
    </>
  );
}
