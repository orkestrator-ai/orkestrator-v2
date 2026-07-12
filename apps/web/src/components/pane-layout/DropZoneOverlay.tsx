import { useDroppable, useDndContext } from "@dnd-kit/core";
import { createEdgeDroppableId, type EdgeDirection } from "@/types/paneLayout";
import { cn } from "@/lib/utils";

interface DropZoneOverlayProps {
  paneId: string;
}

interface EdgeZoneProps {
  paneId: string;
  direction: EdgeDirection;
}

function EdgeZone({ paneId, direction }: EdgeZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: createEdgeDroppableId(paneId, direction),
  });

  // Position classes based on direction
  const positionClasses = {
    left: "left-0 top-0 bottom-0 w-16",
    right: "right-0 top-0 bottom-0 w-16",
    top: "top-0 left-0 right-0 h-16",
    bottom: "bottom-0 left-0 right-0 h-16",
  };

  // Preview position classes (show where the split will appear)
  const previewClasses = {
    left: "left-0 top-0 bottom-0 w-1/2",
    right: "right-0 top-0 bottom-0 w-1/2",
    top: "top-0 left-0 right-0 h-1/2",
    bottom: "bottom-0 left-0 right-0 h-1/2",
  };

  return (
    <>
      {/* Invisible drop zone */}
      <div
        ref={setNodeRef}
        className={cn(
          "absolute z-[60] pointer-events-auto",
          positionClasses[direction]
        )}
      />

      {/* Visual preview when hovering */}
      {isOver && (
        <div
          className={cn(
            "absolute z-[55] bg-primary/20 border-2 border-primary/40 pointer-events-none transition-all duration-150",
            previewClasses[direction]
          )}
        />
      )}
    </>
  );
}

export function DropZoneOverlay({ paneId }: DropZoneOverlayProps) {
  const { active } = useDndContext();

  // Only show drop zones when actively dragging a tab
  if (!active) {
    return null;
  }

  return (
    <div className="absolute inset-0 pointer-events-none z-50">
      <EdgeZone paneId={paneId} direction="left" />
      <EdgeZone paneId={paneId} direction="right" />
      <EdgeZone paneId={paneId} direction="top" />
      <EdgeZone paneId={paneId} direction="bottom" />
    </div>
  );
}
