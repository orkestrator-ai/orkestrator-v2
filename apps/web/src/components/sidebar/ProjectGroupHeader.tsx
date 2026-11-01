import { useRef, type ReactNode, type Ref } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import {
  ChevronRight,
  Copy,
  FolderInput,
  FolderMinus,
  LayoutGrid,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { GithubIcon } from "@/components/icons/GithubIcon";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { HoverTooltipContent, useHoverTooltip } from "@/components/ui/hover-tooltip";
import { cn } from "@/lib/utils";

/** What a project's context menu can do. Optional entries appear only where they apply. */
export interface ProjectMenuActions {
  openBoard: () => void;
  openGithub?: () => void;
  openSettings: () => void;
  newEnvironment: () => void;
  /** Copies the project to another machine; present only when there is one. */
  copyToMachine?: () => void;
  /** Opens the folder composer; omitted where folders are not arranged. */
  addToFolder?: () => void;
  /** Lifts the project back out to the root level; omitted when it has no folder. */
  removeFromFolder?: () => void;
  deleteProject: () => void;
}

/** What the project header's hover card says. */
export interface ProjectCardDetails {
  /** The repository: its Git URL, or another machine's `host/owner/name` hint. */
  repository?: string;
  /** Where the checkout is: its path, or another machine's checkout folder name. */
  path?: string;
  environmentCount: number;
  runningCount: number;
  /** What a click on the header opens. */
  openHint: string;
}

/**
 * The header of a project in the sidebar, for this window's machine and other
 * machines alike: the drag handle and name, the environment count, agent-mail
 * badges, the hover card, the context menu, the project home's activity, the
 * "+" button and the chevron. `SortableProjectGroup` and `RemoteProjectGroup`
 * only supply the facts and actions.
 */
export function ProjectGroupHeader({
  projectName,
  accessibleLabel,
  label,
  labelClassName,
  icon,
  card,
  unreadMail,
  failedMail,
  highlighted,
  ariaCurrent,
  sortable,
  dragAttributes,
  dragListeners,
  rowRef,
  isCollapsed,
  onOpen,
  menu,
  writable,
  homeActivity,
  newEnvironment,
}: {
  projectName: string;
  accessibleLabel?: string;
  label: string;
  labelClassName?: string;
  /** The machine home or project icon before the name. */
  icon?: ReactNode;
  card: ProjectCardDetails;
  unreadMail: number;
  failedMail: boolean;
  /** Selected, or revealed by the project search. */
  highlighted: boolean;
  ariaCurrent: "page" | "true" | undefined;
  sortable: boolean;
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  rowRef?: Ref<HTMLDivElement>;
  isCollapsed: boolean;
  onOpen: () => void;
  menu: ProjectMenuActions;
  /** The owning machine accepts writes; settings, creation, copy and delete need it. */
  writable: boolean;
  homeActivity?: ReactNode;
  newEnvironment: { label: string; title: string };
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const tooltip = useHoverTooltip();
  return (
    <div
      ref={rowRef}
      className={cn(
        "relative mx-1 flex items-center group/project rounded-lg border border-transparent transition-colors",
        highlighted
          ? "bg-linear-to-r from-selected to-selected-edge text-selected-foreground"
          : "hover:bg-hover",
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          <button
            {...(sortable ? dragAttributes : {})}
            {...(sortable ? dragListeners : {})}
            ref={anchorRef}
            type="button"
            aria-current={ariaCurrent}
            aria-label={accessibleLabel}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground",
              sortable && "cursor-grab active:cursor-grabbing",
            )}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            onMouseEnter={tooltip.show}
            onMouseLeave={tooltip.hide}
            onFocus={tooltip.show}
            onBlur={tooltip.hide}
          >
            {icon}
            <span className={cn("truncate font-medium", labelClassName)}>{label}</span>
            {card.environmentCount > 0 && (
              <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-md bg-white/[0.07] px-1 text-[10px] text-zinc-300">
                {card.environmentCount}
              </span>
            )}
            {unreadMail > 0 && (
              <span
                className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-cyan-400/90 px-1 font-mono text-[9px] text-zinc-950"
                aria-label={`${unreadMail} unread agent messages`}
              >
                {unreadMail > 99 ? "99+" : unreadMail}
              </span>
            )}
            {failedMail && (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-amber-400"
                aria-label="Agent message delivery failed"
              />
            )}
          </button>
        </ContextMenuTrigger>
        <HoverTooltipContent
          anchorRef={anchorRef}
          open={tooltip.open}
          side="right"
          align="center"
          onMouseEnter={tooltip.show}
          onMouseLeave={tooltip.hide}
        >
          {card.repository && <p className="font-mono text-xs">{card.repository}</p>}
          {card.path && <p className="text-xs text-muted-foreground">{card.path}</p>}
          <p className="text-xs text-muted-foreground mt-1">
            {card.environmentCount} environment
            {card.environmentCount !== 1 && "s"}
            {card.runningCount > 0 && ` (${card.runningCount} running)`}
          </p>
          <p className="text-xs text-muted-foreground">{card.openHint}</p>
        </HoverTooltipContent>
        <ContextMenuContent>
          <ContextMenuItem onClick={menu.openBoard}>
            <LayoutGrid className="h-4 w-4 mr-2" />
            Open Board
          </ContextMenuItem>
          {menu.openGithub && (
            <ContextMenuItem onClick={menu.openGithub}>
              <GithubIcon className="h-4 w-4 mr-2" />
              Open Repo on GitHub
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!writable} onClick={menu.openSettings}>
            <Settings2 className="h-4 w-4 mr-2" />
            Repository Settings
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!writable} onClick={menu.newEnvironment}>
            <Plus className="h-4 w-4 mr-2" />
            New Environment
          </ContextMenuItem>
          {menu.copyToMachine && (
            <ContextMenuItem disabled={!writable} onClick={menu.copyToMachine}>
              <Copy className="h-4 w-4 mr-2" />
              Copy to Machine…
            </ContextMenuItem>
          )}
          {menu.addToFolder && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={menu.addToFolder}>
                <FolderInput className="h-4 w-4 mr-2" />
                Add to Folder
              </ContextMenuItem>
              {menu.removeFromFolder && (
                <ContextMenuItem onClick={menu.removeFromFolder}>
                  <FolderMinus className="h-4 w-4 mr-2" />
                  Remove from Folder
                </ContextMenuItem>
              )}
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" disabled={!writable} onClick={menu.deleteProject}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Project
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {homeActivity}

      {/* Visible on compact layouts and revealed on desktop hover. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-muted-foreground opacity-100 transition-opacity hover:text-foreground md:opacity-0 md:group-hover/project:opacity-100 md:focus-visible:opacity-100"
        disabled={!writable}
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.blur();
          menu.newEnvironment();
        }}
        aria-label={newEnvironment.label}
        title={newEnvironment.title}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
      {/* The name is also the drag handle, and dnd-kit's keyboard sensor owns
          Enter and Space there. This chevron carries no drag listeners, so it
          is the control a keyboard user can actually expand the project with —
          and it needs its own label, because nothing inside it is text. It
          sits last, as on folder and repository headings. */}
      <CollapsibleTrigger
        className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/[0.07]"
        aria-label={
          isCollapsed ? `Expand project ${projectName}` : `Collapse project ${projectName}`
        }
        onClick={(event) => event.stopPropagation()}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-200",
            !isCollapsed && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
    </div>
  );
}
