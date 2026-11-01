import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The selected environment row. The accent bar and the drag grip occupy the
 * same few pixels, so they take turns: the bar fades out exactly as the grip
 * fades in. `hover:` rather than `group-hover/sortable:` because the group and
 * the pseudo-element are the same element, and `group-*` only reaches
 * descendants.
 */
export const SELECTED_ENVIRONMENT_ROW_CLASS =
  "relative overflow-hidden border-transparent bg-linear-to-r from-selected to-selected-edge text-selected-foreground before:absolute before:inset-y-1 before:left-1 before:w-0.5 before:rounded-full before:bg-primary before:transition-opacity hover:before:opacity-0";

/** The selected row in the activity list, which has no grip for the bar to give way to. */
const SELECTED_ACTIVITY_ROW_CLASS =
  "relative overflow-hidden bg-linear-to-r from-selected to-selected-edge text-selected-foreground before:absolute before:inset-y-1 before:left-1 before:w-0.5 before:rounded-full before:bg-primary";

/** Attributes a list puts on a row frame for tests and selection lookups. */
export type EnvironmentRowFrameData = Record<`data-${string}`, string | boolean | undefined>;

/**
 * An environment row in a project's list, for this window's machine and other
 * machines alike: the drag grip (a spacer where it cannot be moved), the
 * selected background, and the dimming of a machine that is not reachable.
 */
export function SortableEnvironmentRowFrame({
  sortableId,
  sortable,
  selected,
  offline = false,
  name,
  spacerTestId,
  data,
  children,
}: {
  sortableId: string;
  /** Project homes, unavailable machines and truncated lists are not sortable. */
  sortable: boolean;
  selected: boolean;
  offline?: boolean;
  /** The environment's name, for the grip's label. */
  name: string;
  spacerTestId?: string;
  data?: EnvironmentRowFrameData;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled: !sortable,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "opacity-50 z-50")}
      {...data}
    >
      <div
        className={cn(
          "group/sortable mx-1 flex items-center rounded-lg border border-transparent transition-colors",
          selected ? SELECTED_ENVIRONMENT_ROW_CLASS : "hover:bg-environment-hover",
          offline && "opacity-60",
        )}
      >
        {sortable ? (
          <button
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${name}`}
            className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover/sortable:opacity-100"
          >
            <GripVertical className="h-3 w-3" />
          </button>
        ) : (
          // Reserves the grip's width so its icon lines up with the other rows.
          <span aria-hidden="true" data-testid={spacerTestId} className="h-6 w-4 shrink-0" />
        )}
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

/** The class of an activity-list row, for this window's machine and other machines alike. */
export function activityRowClassName(selected: boolean, offline = false): string {
  return cn(
    "mx-1 flex items-center rounded-lg border border-transparent transition-colors",
    selected ? SELECTED_ACTIVITY_ROW_CLASS : "hover:bg-environment-hover",
    offline && "opacity-60",
  );
}
