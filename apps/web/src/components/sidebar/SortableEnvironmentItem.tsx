import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { EnvironmentItem } from "@/components/environments/EnvironmentItem";
import type { Environment } from "@/types";
import { cn } from "@/lib/utils";

interface SortableEnvironmentItemProps {
  environment: Environment;
  isSelected: boolean;
  onSelect: (environmentId: string, modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  onDelete: (environmentId: string) => void;
  onStart: (environmentId: string) => void;
  onStop: (environmentId: string) => void;
  onRestart: (environmentId: string) => void;
  onUpdate?: (environment: Environment) => void;
  isMultiSelectMode?: boolean;
  isChecked?: boolean;
}

export function SortableEnvironmentItem({
  environment,
  isSelected,
  onSelect,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onUpdate,
  isMultiSelectMode = false,
  isChecked = false,
}: SortableEnvironmentItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: environment.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-50 z-50")}>
      <div
        className={cn(
          "group/sortable mx-1 flex items-center rounded-lg border border-transparent transition-colors",
          isSelected && !isMultiSelectMode
            ? // The accent bar and the drag grip occupy the same few pixels, so
              // they take turns: the bar fades out exactly as the grip fades in.
              // `hover:` rather than `group-hover/sortable:` because the group
              // and the pseudo-element are the same element, and `group-*`
              // only reaches descendants.
              "relative overflow-hidden border-transparent bg-linear-to-r from-selected to-selected-edge text-selected-foreground before:absolute before:inset-y-1 before:left-1 before:w-0.5 before:rounded-full before:bg-primary before:transition-opacity hover:before:opacity-0"
            : "hover:bg-environment-hover",
        )}
      >
        {/* Drag handle - far left */}
        <button
          {...attributes}
          {...listeners}
          className={cn(
            "flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing",
            "group-hover/sortable:opacity-100",
          )}
        >
          <GripVertical className="h-3 w-3" />
        </button>

        {/* Environment item */}
        <div className="flex-1 min-w-0">
          <EnvironmentItem
            environment={environment}
            isSelected={isSelected}
            onSelect={onSelect}
            onDelete={onDelete}
            onStart={onStart}
            onStop={onStop}
            onRestart={onRestart}
            onUpdate={onUpdate}
            isMultiSelectMode={isMultiSelectMode}
            isChecked={isChecked}
          />
        </div>
      </div>
    </div>
  );
}
