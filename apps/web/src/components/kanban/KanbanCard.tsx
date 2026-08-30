import { useRef, useEffect } from "react";
import { useDraggable } from "@dnd-kit/core";
import { MessageSquare, MoreHorizontal, RotateCcw, SquareArrowOutUpRight } from "lucide-react";
import type { KanbanStatus, KanbanTask } from "@/stores/kanbanStore";
import { isActiveBuildPhase, type BuildPhase } from "@/stores/buildPipelineStore";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Left accent stripe, matching the dot colour of the column the card sits in so
 * a card that has been dragged out of view still reads as belonging to its
 * status.
 */
const STATUS_ACCENT: Record<KanbanStatus, string> = {
  backlog: "bg-zinc-600",
  "in-progress": "bg-blue-500",
  review: "bg-amber-500",
  done: "bg-green-500",
};

function getBuildPhaseDisplay(phase: BuildPhase): { label: string; className: string } {
  switch (phase) {
    case "creating-environment":
      return {
        label: "Creating Env",
        className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
      };
    case "starting-environment":
      return {
        label: "Starting Env",
        className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
      };
    case "waiting-for-setup":
      return { label: "Setting Up", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" };
    case "building":
      return { label: "Building", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
    case "reviewing":
      return {
        label: "Reviewing",
        className: "bg-purple-500/15 text-purple-400 border-purple-500/30",
      };
    case "addressing":
      return {
        label: "Addressing",
        className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      };
    case "verifying":
      return { label: "Verifying", className: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30" };
    case "fixing":
      return {
        label: "Fixing",
        className: "bg-orange-500/15 text-orange-400 border-orange-500/30",
      };
    case "creating-pr":
      return {
        label: "Creating PR",
        className: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
      };
    case "resolving-conflicts":
      return {
        label: "Resolving",
        className: "bg-orange-500/15 text-orange-400 border-orange-500/30",
      };
    case "paused":
      return { label: "Paused", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
    case "complete":
      return { label: "Complete", className: "bg-green-500/15 text-green-400 border-green-500/30" };
    case "failed":
      return { label: "Failed", className: "bg-red-500/15 text-red-400 border-red-500/30" };
  }
}

interface KanbanCardProps {
  task: KanbanTask;
  onClick: () => void;
  isDragOverlay?: boolean;
  buildPhase?: BuildPhase;
  /** Name of the environment linked to this task, when one is known. */
  environmentName?: string;
  canClearStatus?: boolean;
  onClearStatus?: (task: KanbanTask) => void;
}

export function KanbanCard({
  task,
  onClick,
  isDragOverlay,
  buildPhase,
  environmentName,
  canClearStatus,
  onClearStatus,
}: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { type: "task", task },
  });

  const wasDraggingRef = useRef(false);

  useEffect(() => {
    if (isDragging) {
      wasDraggingRef.current = true;
    } else if (wasDraggingRef.current) {
      // Reset after a short delay so the synchronous click event
      // on mouseup can still see the flag before it's cleared
      const timer = setTimeout(() => {
        wasDraggingRef.current = false;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isDragging]);

  const handleClick = () => {
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    onClick();
  };

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;

  const phaseDisplay = buildPhase ? getBuildPhaseDisplay(buildPhase) : null;
  const isActivelyBuilding = buildPhase ? isActiveBuildPhase(buildPhase) : false;
  const commentCount = task.comments.length;
  const hasFooter = commentCount > 0 || !!environmentName;

  // While the card is being dragged the overlay copy follows the pointer, so
  // the original stays put and renders as a dashed drop target. It deliberately
  // does not take `style`: the transform belongs to the overlay, and applying it
  // here would drag the outline along too.
  if (isDragging && !isDragOverlay) {
    return (
      <div
        ref={setNodeRef}
        data-testid="kanban-card-drop-placeholder"
        className="rounded-lg border border-dashed border-primary/60 bg-primary/5"
        aria-hidden="true"
      >
        <div className="invisible p-3 pl-4">
          <div className="min-w-0 pb-8">
            <h4 className="truncate text-sm font-medium">{task.title}</h4>
            {task.description && <p className="mt-1 text-xs line-clamp-2">{task.description}</p>}
            {hasFooter && <div className="mt-2 h-4" />}
          </div>
        </div>
      </div>
    );
  }

  const card = (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="kanban-card"
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-card p-3 pl-4 shadow-sm",
        "cursor-grab active:cursor-grabbing",
        "transition-[border-color,box-shadow,background-color]",
        "border-border hover:border-primary/50 hover:bg-accent/20 hover:shadow-md",
        isDragOverlay && "rotate-1 border-primary/60 shadow-2xl shadow-black/50",
      )}
      {...attributes}
      {...listeners}
      onClick={handleClick}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-[3px]", STATUS_ACCENT[task.status])}
      />
      <div className="min-w-0 flex-1 pb-8">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-medium text-foreground truncate">{task.title}</h4>
          <div className="flex shrink-0 items-center gap-1">
            {phaseDisplay && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide leading-none",
                  phaseDisplay.className,
                  isActivelyBuilding && "animate-pulse",
                )}
              >
                {phaseDisplay.label}
              </span>
            )}
            {!isDragOverlay && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Task actions for ${task.title}`}
                    className="pointer-events-none -mr-1 -mt-0.5 h-5 w-5 text-muted-foreground opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-44"
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <DropdownMenuItem onSelect={() => onClick()}>
                    <SquareArrowOutUpRight className="h-4 w-4" />
                    Open task
                  </DropdownMenuItem>
                  {canClearStatus && (
                    <DropdownMenuItem onSelect={() => onClearStatus?.(task)}>
                      <RotateCcw className="h-4 w-4" />
                      Clear status
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {task.description && (
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{task.description}</p>
        )}
        {hasFooter && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            {commentCount > 0 && (
              <span className="flex shrink-0 items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                <span>{commentCount}</span>
              </span>
            )}
            {environmentName && (
              <>
                {commentCount > 0 && (
                  <span aria-hidden="true" className="text-border">
                    |
                  </span>
                )}
                <span
                  className="truncate font-mono text-[11px] text-muted-foreground/80"
                  title={environmentName}
                >
                  {environmentName}
                </span>
              </>
            )}
          </div>
        )}
      </div>
      {!isDragOverlay && (
        <Button
          variant="outline"
          size="sm"
          className="pointer-events-none absolute bottom-2.5 right-2.5 h-6 px-2 text-[11px] opacity-0 shadow-sm transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          Open
        </Button>
      )}
    </div>
  );

  if (isDragOverlay || !canClearStatus) {
    return card;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => onClearStatus?.(task)}>
          <RotateCcw className="h-4 w-4" />
          Clear status
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
