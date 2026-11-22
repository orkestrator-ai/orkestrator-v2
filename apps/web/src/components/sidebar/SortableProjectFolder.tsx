import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDndContext } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDownAZ,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Folder,
  FolderMinus,
  FolderOpen,
  LayoutGrid,
  MessagesSquare,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { GithubIcon } from "@/components/icons/GithubIcon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { RepositoryMemberContext } from "@/contexts/RepositoryMemberContext";
import { MAX_PROJECT_FOLDER_NAME_LENGTH } from "@orkestrator/protocol/project-folders";
import { parseProjectFolderDragId, projectFolderDragId } from "@/lib/project-folders";
import { cn } from "@/lib/utils";

/**
 * What a repository heading's context menu can do. Every entry acts on the
 * member the heading opens, on the machine it names.
 */
export interface RepositoryMenuActions {
  /** The machine of the member the entries act on. */
  machineName: string;
  /** The member's machine accepts writes; settings and creation need it. */
  writable: boolean;
  /** What a click on the heading opens; absent where the coordinator is gated. */
  openCoordinator?: () => void;
  openBoard: () => void;
  openGithub?: () => void;
  openSettings: () => void;
  newEnvironment: () => void;
  /**
   * The repository's copies on its other machines: with no per-machine
   * headings under the repository, the menu is where an environment is
   * created on one of them.
   */
  /** Copies the member's project to another machine. */
  copyToMachine?: () => void;
  /** Opens the member's Delete project confirmation on its machine. */
  deleteProject?: () => void;
  newEnvironmentOn?: ReadonlyArray<{
    key: string;
    machineName: string;
    writable: boolean;
    onSelect: () => void;
  }>;
}

interface SortableProjectFolderProps {
  name: string;
  sortableId?: string;
  projectCount: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Folder actions; a repository group has `repositoryMenu` instead. */
  onRename?: (nextName: string) => void | Promise<void>;
  onSort?: () => void | Promise<void>;
  onUngroup?: () => void | Promise<void>;
  /** Shown instead of `name`, which stays the folder's identity. */
  label?: string;
  /** A repository group rather than a folder: a two-line heading over unindented members. */
  repository?: boolean;
  /** Rule before a repository, kept inside its measured drop target. */
  repositorySeparator?: boolean;
  /** A repository group's leading icon, spanning both lines of its heading. */
  icon?: ReactNode;
  /** A repository group's second line. */
  subtitle?: string;
  /** Clicking the name opens this instead of toggling; the chevron still toggles. */
  onOpen?: () => void;
  /** What `onOpen` opened is shown: highlighted like a selected project. */
  selected?: boolean;
  /** Destination named by the repository navigation control. */
  openMachineName?: string;
  /** A repository group's context menu. */
  repositoryMenu?: RepositoryMenuActions;
  /**
   * A + button before the chevron (design EL01). The chevron, the context
   * menu's Expand/Collapse and the keyboard on the heading (Left collapses,
   * Right expands) all drive the same `isCollapsed`.
   */
  addAction?: { label: string; title: string; disabled?: boolean; onAdd: () => void };
  /** Shown between the heading and its + button (project home activity). */
  trailing?: ReactNode;
  /** Chosen in the project search: highlighted, and scrolled into view on each `revealRevision`. */
  revealRevision?: number | null;
  children: ReactNode;
}

/**
 * One sidebar folder: a draggable, droppable header over its member projects.
 *
 * The header is the drop target for "put this project in this folder", which
 * is why it stays rendered — and stays a sortable node — while collapsed. A
 * collapsed folder hides its members but must still accept them.
 */
export function SortableProjectFolder({
  name,
  sortableId,
  projectCount,
  isCollapsed,
  onToggleCollapse,
  onRename,
  onSort,
  onUngroup,
  label = name,
  repository = false,
  repositorySeparator = false,
  icon,
  subtitle,
  onOpen,
  selected = false,
  openMachineName,
  repositoryMenu,
  addAction,
  trailing,
  revealRevision = null,
  children,
}: SortableProjectFolderProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const renameInputId = useId();
  const suppressClick = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const revealed = revealRevision !== null;
  useEffect(() => {
    if (revealRevision === null) return;
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [revealRevision]);

  const { active } = useDndContext();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: sortableId ?? projectFolderDragId(name),
    data: { sidebarGroup: true },
  });
  useEffect(() => {
    if (isDragging) {
      suppressClick.current = true;
      return;
    }
    if (!suppressClick.current) return;
    // Keep the guard through the mouseup click, including when the heading
    // moves with the pointer and remains under it at the drop destination.
    const timer = setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [isDragging]);

  const canHighlightDrop =
    !repository || (active && parseProjectFolderDragId(String(active.id)) !== null);
  const destination = openMachineName ? ` on ${openMachineName}` : "";

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const commitRename = () => {
    setIsRenaming(false);
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === name) return;
    void onRename?.(trimmed);
  };

  // Renaming happens in a dialog rather than inline in the header. Closing the
  // context menu restores focus to its trigger, which would blur — and so
  // cancel — an inline field the moment it appeared.

  const FolderIcon = isCollapsed ? Folder : FolderOpen;
  // "owner/repo": the owner recedes so the repository name leads.
  const ownerEnd = repository ? label.lastIndexOf("/") + 1 : 0;
  const hasMenu = Boolean(onRename || onSort || onUngroup || repositoryMenu);
  // A repository heading collapses a project's environments; a folder its projects.
  const kind = repository ? "project" : "folder";
  const repositoryActionSize = "[@media(max-width:767px)]:size-10 pointer-coarse:size-10";

  // The whole heading is the drag handle. A repository heading also opens on
  // click, so its keyboard drag starts on Space only and Enter keeps the
  // native activation that opens it.
  // Beside its chevron, Left and Right on a heading with a + collapse and
  // expand it from the keyboard.
  const headingListeners =
    onOpen && listeners
      ? {
          ...listeners,
          onKeyDown: (event: KeyboardEvent) => {
            if (addAction && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
              event.preventDefault();
              if ((event.key === "ArrowLeft") !== isCollapsed) onToggleCollapse();
              return;
            }
            if (event.code === "Space") listeners.onKeyDown?.(event);
          },
        }
      : listeners;
  const heading = (
    <button
      {...attributes}
      {...headingListeners}
      ref={setActivatorNodeRef}
      type="button"
      // A heading that opens is not the disclosure: its chevron reports the state.
      aria-expanded={onOpen ? undefined : !isCollapsed}
      aria-current={selected ? "page" : undefined}
      aria-label={onOpen ? `Open ${label}${destination}` : undefined}
      title={
        onOpen
          ? `Open ${name}${destination}`
          : isCollapsed
            ? `Expand folder ${label}`
            : `Collapse folder ${label}`
      }
      className={cn(
        "flex min-w-0 flex-1 cursor-grab items-center rounded-lg py-1.5 text-left text-sm text-foreground active:cursor-grabbing",
        // A repository's row spans its environment rows' frame, so the
        // heading takes the grip column (16px) before its icon instead.
        repository ? "gap-2.5 pr-2 pl-4" : "gap-2 px-2",
      )}
      onClick={(event) => {
        event.stopPropagation();
        if (suppressClick.current) return;
        if (onOpen) onOpen();
        else onToggleCollapse();
      }}
    >
      {repository ? (
        <>
          {icon}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">
              <span className="text-muted-foreground">{label.slice(0, ownerEnd)}</span>
              <span className="text-foreground">{label.slice(ownerEnd)}</span>
            </span>
            {subtitle ? (
              <span className="truncate text-[11px] leading-4 text-muted-foreground">
                {subtitle}
              </span>
            ) : null}
          </span>
        </>
      ) : (
        <>
          <FolderIcon className="h-4 w-4 shrink-0 text-amber-400/80" aria-hidden="true" />
          <span className="truncate font-medium">{label}</span>
        </>
      )}
      {repository ? null : (
        <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-md bg-white/[0.07] px-1 text-[10px] text-zinc-300">
          {projectCount}
        </span>
      )}
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-project-folder={name}
      // A repository heading is inset like its environment rows (`mx-1`), so
      // its chevron ends where their changed-line counts do; a folder keeps
      // the project groups' `px-2`.
      className={cn(repository ? "py-0.5" : "px-2 py-0.5", isDragging && "z-50 opacity-50")}
    >
      {repository && repositorySeparator ? (
        <div className="px-3 py-1">
          <Separator data-testid="repository-separator" />
        </div>
      ) : null}
      <div
        ref={rowRef}
        data-revealed={revealed || undefined}
        className={cn(
          "relative mx-1 flex items-center rounded-lg border transition-colors",
          // A drop lands inside the folder rather than beside it, so the whole
          // header is highlighted rather than an insertion line being drawn.
          isOver && !isDragging && canHighlightDrop
            ? "border-primary/70 bg-primary/10"
            : selected || revealed
              ? "border-transparent bg-linear-to-r from-selected to-selected-edge text-selected-foreground"
              : "border-transparent hover:bg-hover",
        )}
      >
        {hasMenu ? (
          <ContextMenu>
            <ContextMenuTrigger className="contents">{heading}</ContextMenuTrigger>
            <ContextMenuContent>
              {repositoryMenu ? (
                <RepositoryMenuItems
                  actions={repositoryMenu}
                  isCollapsed={isCollapsed}
                  onToggleCollapse={onToggleCollapse}
                />
              ) : null}
              {onRename ? (
                <ContextMenuItem
                  onClick={() => {
                    setDraftName(name);
                    setIsRenaming(true);
                  }}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Rename folder
                </ContextMenuItem>
              ) : null}
              {onSort ? (
                <ContextMenuItem onClick={() => void onSort()}>
                  <ArrowDownAZ className="mr-2 h-4 w-4" />
                  Sort
                </ContextMenuItem>
              ) : null}
              {onUngroup ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => void onUngroup()}>
                    <FolderMinus className="mr-2 h-4 w-4" />
                    Remove folder
                  </ContextMenuItem>
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          heading
        )}

        {trailing}
        {addAction ? (
          <button
            type="button"
            aria-label={addAction.label}
            title={addAction.title}
            disabled={addAction.disabled}
            data-testid="repository-new-environment"
            className={cn(
              "grid shrink-0 place-items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
              repositoryActionSize,
            )}
            onClick={(event) => {
              event.stopPropagation();
              addAction.onAdd();
            }}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
        {/* Reserve 36px for the phone row's actions (32px + 8px gap - 4px
            margin). Share it between the outer margin and the inner padding
            to keep the 40px hit area closer to the sidebar edge. */}
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${kind} ${label}`}
          data-testid={repository ? "repository-collapse-toggle" : undefined}
          className={cn(
            "grid shrink-0 items-center rounded-md transition-colors hover:bg-white/[0.07]",
            repository
              ? cn(
                  "justify-items-end py-1 pr-2 [@media(max-width:767px)]:mr-6 [@media(max-width:767px)]:pr-5",
                  repositoryActionSize,
                )
              : "justify-items-center p-1",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapse();
          }}
        >
          {/* Match the count's 8px inset. The open 16px glyph has 4px of
              right-side bearing, so the icon extends 4px past this edge. */}
          <span aria-hidden="true">
            <ChevronRight
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform duration-200",
                repository && "translate-x-1",
                !isCollapsed && "rotate-90",
              )}
            />
          </span>
        </button>
      </div>

      {/*
        Members are unmounted while collapsed rather than hidden with CSS: they
        are sortable nodes, and a registered node the user cannot see would
        still resolve drops. A folder cancels its right padding so member
        chevrons line up with top-level ones; members bring their own. A
        repository has no padding to cancel: its rows share the heading's edges.
      */}
      {!isCollapsed && (
        <div
          className={repository ? undefined : "-mr-2 ml-3 border-l border-zinc-800/80 pl-1"}
          data-project-folder-content={name}
        >
          <RepositoryMemberContext.Provider value={repository}>
            {children}
          </RepositoryMemberContext.Provider>
        </div>
      )}

      <Dialog open={isRenaming} onOpenChange={setIsRenaming}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>
              Every project in <strong className="text-foreground">{name}</strong> moves to the new
              name.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              commitRename();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={renameInputId}>Folder name</Label>
              <Input
                id={renameInputId}
                autoFocus
                aria-label={`Rename folder ${name}`}
                value={draftName}
                maxLength={MAX_PROJECT_FOLDER_NAME_LENGTH}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setIsRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!draftName.trim()}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RepositoryMenuItems({
  actions,
  isCollapsed,
  onToggleCollapse,
}: {
  actions: RepositoryMenuActions;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <>
      <ContextMenuLabel className="text-xs font-normal text-muted-foreground">
        On {actions.machineName}
      </ContextMenuLabel>
      {actions.openCoordinator ? (
        <ContextMenuItem onClick={actions.openCoordinator}>
          <MessagesSquare className="mr-2 h-4 w-4" />
          Open Coordinator
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onClick={actions.openBoard}>
        <LayoutGrid className="mr-2 h-4 w-4" />
        Open board
      </ContextMenuItem>
      {actions.openGithub ? (
        <ContextMenuItem onClick={actions.openGithub}>
          <GithubIcon className="mr-2 h-4 w-4" />
          Open repo on GitHub
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!actions.writable} onClick={actions.openSettings}>
        <Settings2 className="mr-2 h-4 w-4" />
        Repository settings
      </ContextMenuItem>
      <ContextMenuItem disabled={!actions.writable} onClick={actions.newEnvironment}>
        <Plus className="mr-2 h-4 w-4" />
        New environment
      </ContextMenuItem>
      {actions.newEnvironmentOn?.map((other) => (
        <ContextMenuItem key={other.key} disabled={!other.writable} onClick={other.onSelect}>
          <Plus className="mr-2 h-4 w-4" />
          New environment on {other.machineName}
        </ContextMenuItem>
      ))}
      {actions.copyToMachine ? (
        <ContextMenuItem disabled={!actions.writable} onClick={actions.copyToMachine}>
          <Copy className="mr-2 h-4 w-4" />
          Copy to Machine…
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onToggleCollapse}>
        {isCollapsed ? (
          <ChevronsUpDown className="mr-2 h-4 w-4" />
        ) : (
          <ChevronsDownUp className="mr-2 h-4 w-4" />
        )}
        {isCollapsed ? "Expand" : "Collapse"}
      </ContextMenuItem>
      {actions.deleteProject ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={!actions.writable}
            onClick={actions.deleteProject}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete project on {actions.machineName}…
          </ContextMenuItem>
        </>
      ) : null}
    </>
  );
}
