import { useEffect, useId, useState, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Folder, FolderOpen, FolderMinus, Pencil } from "lucide-react";
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
import { MAX_PROJECT_FOLDER_NAME_LENGTH } from "@orkestrator/protocol/project-folders";
import { projectFolderDragId } from "@/lib/project-folders";
import { cn } from "@/lib/utils";

interface SortableProjectFolderProps {
  name: string;
  projectCount: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onRename: (nextName: string) => void | Promise<void>;
  onUngroup: () => void | Promise<void>;
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
  projectCount,
  isCollapsed,
  onToggleCollapse,
  onRename,
  onUngroup,
  children,
}: SortableProjectFolderProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const renameInputId = useId();

  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: projectFolderDragId(name) });

  useEffect(() => {
    if (isRenaming) setDraftName(name);
  }, [isRenaming, name]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const commitRename = () => {
    setIsRenaming(false);
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === name) return;
    void onRename(trimmed);
  };

  // Renaming happens in a dialog rather than inline in the header. Closing the
  // context menu restores focus to its trigger, which would blur — and so
  // cancel — an inline field the moment it appeared.

  const FolderIcon = isCollapsed ? Folder : FolderOpen;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-project-folder={name}
      className={cn("px-2 py-0.5", isDragging && "z-50 opacity-50")}
    >
      <div
        className={cn(
          "relative mx-1 flex items-center rounded-lg border transition-colors",
          // A drop lands inside the folder rather than beside it, so the whole
          // header is highlighted rather than an insertion line being drawn.
          isOver && !isDragging
            ? "border-primary/70 bg-primary/10"
            : "border-transparent hover:bg-hover",
        )}
      >
        <ContextMenu>
          <ContextMenuTrigger className="contents">
            <button
              {...attributes}
              {...listeners}
              type="button"
              aria-expanded={!isCollapsed}
              title={isCollapsed ? `Expand folder ${name}` : `Collapse folder ${name}`}
              className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground active:cursor-grabbing"
              onClick={(event) => {
                event.stopPropagation();
                onToggleCollapse();
              }}
            >
              <FolderIcon className="h-4 w-4 shrink-0 text-amber-400/80" aria-hidden="true" />
              <span className="truncate font-medium">{name}</span>
              <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-md bg-white/[0.07] px-1 text-[10px] text-zinc-300">
                {projectCount}
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => setIsRenaming(true)}>
              <Pencil className="mr-2 h-4 w-4" />
              Rename Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void onUngroup()}>
              <FolderMinus className="mr-2 h-4 w-4" />
              Remove Folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/*
          The name is also the drag handle, and dnd-kit's keyboard sensor owns
          Enter and Space there — pressing either starts a drag rather than
          toggling. This chevron carries no drag listeners, so it is the control
          a keyboard user can actually expand the folder with. Project rows are
          built the same way.
        */}
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand folder ${name}` : `Collapse folder ${name}`}
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
        still resolve drops.
      */}
      {!isCollapsed && (
        <div className="ml-3 border-l border-zinc-800/80 pl-1" data-project-folder-content={name}>
          {children}
        </div>
      )}

      <Dialog open={isRenaming} onOpenChange={setIsRenaming}>
        <DialogContent className="sm:max-w-md">
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
