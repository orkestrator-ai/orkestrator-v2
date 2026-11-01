import { EnvironmentItem } from "@/components/environments/EnvironmentItem";
import type { Environment, EnvironmentType } from "@/types";
import { SortableEnvironmentRowFrame } from "./EnvironmentRowFrame";

export { SELECTED_ENVIRONMENT_ROW_CLASS } from "./EnvironmentRowFrame";

interface SortableEnvironmentItemProps {
  environment: Environment;
  isSelected: boolean;
  onSelect: (environmentId: string, modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  onDelete: (environmentId: string) => void;
  onStart: (environmentId: string) => void;
  onStop: (environmentId: string) => void;
  onRestart: (environmentId: string) => void;
  onFork?: (environmentId: string, environmentType: EnvironmentType) => void;
  isMultiSelectMode?: boolean;
  isChecked?: boolean;
}

/** A row of this window's machine in its project, in the frame other machines' rows share. */
export function SortableEnvironmentItem({
  environment,
  isSelected,
  onSelect,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onFork,
  isMultiSelectMode = false,
  isChecked = false,
}: SortableEnvironmentItemProps) {
  return (
    <SortableEnvironmentRowFrame
      sortableId={environment.id}
      // The project home keeps its place at the top of its project.
      sortable={environment.projectHome !== true}
      selected={isSelected && !isMultiSelectMode}
      name={environment.name}
      spacerTestId="project-home-handle-spacer"
    >
      <EnvironmentItem
        environment={environment}
        isSelected={isSelected}
        onSelect={onSelect}
        onDelete={onDelete}
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
        onFork={onFork}
        isMultiSelectMode={isMultiSelectMode}
        isChecked={isChecked}
      />
    </SortableEnvironmentRowFrame>
  );
}
