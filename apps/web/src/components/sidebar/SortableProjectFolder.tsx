import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDndContext } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownAZ, ChevronRight, Folder, FolderOpen, FolderMinus, Pencil } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { MAX_PROJECT_FOLDER_NAME_LENGTH } from "@orkestrator/protocol/project-folders";
import { parseProjectFolderDragId, projectFolderDragId } from "@/lib/project-folders";
import { cn } from "@/lib/utils";

interface SortableProjectFolderProps {
  name: string;
  sortableId?: string;
  projectCount: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Folder actions; a list without them (a repository group) has no menu. */
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
  /** Destination named by the repository navigation control. */
  openMachineName?: string;
  /** Shown instead of the member count. */
  badge?: ReactNode;
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
  openMachineName,
  badge,
  children,
}: SortableProjectFolderProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const renameInputId = useId();
  const suppressClick = useRef(false);

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
  const hasMenu = Boolean(onRename || onSort || onUngroup);

  // The whole heading is the drag handle. A repository heading also opens on
  // click, so its keyboard drag starts on Space only and Enter keeps the
  // native activation that opens it.
  const headingListeners =
    onOpen && listeners
      ? {
          ...listeners,
          onKeyDown: (event: KeyboardEvent) => {
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
      aria-expanded={onOpen ? undefined : !isCollapsed}
      aria-label={onOpen ? `Open ${label}${destination}` : undefined}
      title={
        onOpen
          ? `Open ${name}${destination}`
          : isCollapsed
            ? `Expand folder ${label}`
            : `Collapse folder ${label}`
      }
      className={cn(
        "flex min-w-0 flex-1 cursor-grab items-center rounded-lg px-2 py-1.5 text-left text-sm text-foreground active:cursor-grabbing",
        repository ? "gap-2.5" : "gap-2",
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
      {badge ?? (
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
      className={cn("px-2 py-0.5", isDragging && "z-50 opacity-50")}
    >
      {repository && repositorySeparator ? (
        <div className="px-1 py-1">
          <Separator data-testid="repository-separator" />
        </div>
      ) : null}
      <div
        className={cn(
          "relative mx-1 flex items-center rounded-lg border transition-colors",
          // A drop lands inside the folder rather than beside it, so the whole
          // header is highlighted rather than an insertion line being drawn.
          isOver && !isDragging && canHighlightDrop
            ? "border-primary/70 bg-primary/10"
            : "border-transparent hover:bg-hover",
        )}
      >
        {hasMenu ? (
          <ContextMenu>
            <ContextMenuTrigger className="contents">{heading}</ContextMenuTrigger>
            <ContextMenuContent>
              {onRename ? (
                <ContextMenuItem
                  onClick={() => {
                    setDraftName(name);
                    setIsRenaming(true);
                  }}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Rename Folder
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
                    Remove Folder
                  </ContextMenuItem>
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          heading
        )}

        {/* The chevron collapses independently of navigation and dragging. */}
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand folder ${label}` : `Collapse folder ${label}`}
          className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/[0.07]"
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapse();
          }}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              !isCollapsed && "rotate-90",
            )}
          />
        </button>
      </div>

      {/*
        Members are unmounted while collapsed rather than hidden with CSS: they
        are sortable nodes, and a registered node the user cannot see would
        still resolve drops. Both variants cancel the folder's right padding so
        member chevrons line up with top-level ones; members bring their own.
      */}
      {!isCollapsed && (
        <div
          className={repository ? "-mx-2" : "-mr-2 ml-3 border-l border-zinc-800/80 pl-1"}
          data-project-folder-content={name}
        >
          {children}
        </div>
      )}

      <Dialog open={isRenaming} onOpenChange={setIsRenaming}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Rename Folder</DialogTitle>
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
