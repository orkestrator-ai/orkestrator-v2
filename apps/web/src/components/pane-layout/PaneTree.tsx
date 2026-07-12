import { memo } from "react";
import { isPaneLeaf, isPaneSplit, type PaneNode } from "@/types/paneLayout";
import { PaneSplitContainer } from "./PaneSplitContainer";
import { PaneLeafContainer } from "./PaneLeafContainer";

interface PaneTreeProps {
  node: PaneNode;
  containerId: string | null;
  environmentId: string;
  isActive: boolean;
  /** Currently dragged tab ID (for cross-pane visual feedback) */
  activeDragId?: string | null;
  /** Pane ID currently being dragged over */
  dragOverPaneId?: string | null;
}

export const PaneTree = memo(function PaneTree({
  node,
  containerId,
  environmentId,
  isActive,
  activeDragId,
  dragOverPaneId,
}: PaneTreeProps) {
  if (isPaneLeaf(node)) {
    return (
      <PaneLeafContainer
        pane={node}
        containerId={containerId}
        environmentId={environmentId}
        isActive={isActive}
        activeDragId={activeDragId}
        dragOverPaneId={dragOverPaneId}
      />
    );
  }

  if (isPaneSplit(node)) {
    return (
      <PaneSplitContainer
        split={node}
        containerId={containerId}
        environmentId={environmentId}
        isActive={isActive}
        activeDragId={activeDragId}
        dragOverPaneId={dragOverPaneId}
      />
    );
  }

  return null;
});
