import { useDroppable } from "@dnd-kit/core";
import { PROJECT_ROOT_DROP_ID } from "@/lib/project-folders";
import { cn } from "@/lib/utils";

/**
 * Drop target for the root level.
 *
 * Only rendered while a project is being dragged, and only then does it take
 * up space: a permanent target at the bottom of the list would compete with
 * the last folder's own rows for every drop near the end.
 *
 * It is deliberately tall and offset from the last row to provide a clear
 * pointer-containment target. The spacing also separates its centre from the
 * final project for keyboard drags, which still use `closestCenter`.
 */
export function SidebarRootDropZone({ active }: { active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: PROJECT_ROOT_DROP_ID });
  if (!active) return null;
  return (
    <div
      ref={setNodeRef}
      data-testid="sidebar-root-drop-zone"
      className={cn(
        "mx-3 mt-3 mb-2 flex min-h-16 items-center justify-center rounded-lg border border-dashed px-3 py-4 text-center text-xs transition-colors",
        isOver
          ? "border-primary/70 bg-primary/10 text-foreground"
          : "border-zinc-800 text-zinc-500",
      )}
    >
      Drop here to remove from folder
    </div>
  );
}
