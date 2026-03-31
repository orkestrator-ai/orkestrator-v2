import { useRef, useEffect } from "react";
import { useDraggable } from "@dnd-kit/core";
import { MessageSquare } from "lucide-react";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { BuildPhase } from "@/stores/buildPipelineStore";
import { cn } from "@/lib/utils";

function getBuildPhaseDisplay(phase: BuildPhase): { label: string; className: string } {
  switch (phase) {
    case "creating-environment":
      return { label: "Creating Env", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" };
    case "starting-environment":
      return { label: "Starting Env", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" };
    case "waiting-for-setup":
      return { label: "Setting Up", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" };
    case "building":
      return { label: "Building", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
    case "reviewing":
      return { label: "Reviewing", className: "bg-purple-500/15 text-purple-400 border-purple-500/30" };
    case "addressing":
      return { label: "Addressing", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
    case "verifying":
      return { label: "Verifying", className: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30" };
    case "fixing":
      return { label: "Fixing", className: "bg-orange-500/15 text-orange-400 border-orange-500/30" };
    case "creating-pr":
      return { label: "Creating PR", className: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30" };
    case "resolving-conflicts":
      return { label: "Resolving", className: "bg-orange-500/15 text-orange-400 border-orange-500/30" };
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
}

export function KanbanCard({ task, onClick, isDragOverlay, buildPhase }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
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
  const isActivelyBuilding = buildPhase && !["complete", "failed"].includes(buildPhase);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group rounded-lg border bg-card p-3 shadow-sm cursor-grab active:cursor-grabbing",
        "hover:shadow-md transition-[border-color,box-shadow]",
        "border-border hover:border-primary/50",
        isDragging && "opacity-30",
        isDragOverlay && "shadow-lg border-primary/50 rotate-2"
      )}
      {...attributes}
      {...listeners}
      onClick={handleClick}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-medium text-foreground truncate">{task.title}</h4>
          {phaseDisplay && (
            <span
              className={cn(
                "inline-flex items-center shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none",
                phaseDisplay.className,
                isActivelyBuilding && "animate-pulse"
              )}
            >
              {phaseDisplay.label}
            </span>
          )}
        </div>
        {task.description && (
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
            {task.description}
          </p>
        )}
        {task.comments.length > 0 && (
          <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <MessageSquare className="h-3 w-3" />
            <span>{task.comments.length}</span>
          </div>
        )}
      </div>
    </div>
  );
}
