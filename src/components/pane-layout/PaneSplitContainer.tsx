import { memo, useCallback, useRef, useEffect } from "react";
import { type Layout } from "react-resizable-panels";
import { usePaneLayoutStore } from "@/stores";
import type { PaneSplit } from "@/types/paneLayout";
import { PaneTree } from "./PaneTree";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

/** Debounce delay for store updates during resize operations (ms) */
const RESIZE_DEBOUNCE_MS = 100;

interface PaneSplitContainerProps {
  split: PaneSplit;
  containerId: string | null;
  environmentId: string;
  isActive: boolean;
  /** Currently dragged tab ID (for cross-pane visual feedback) */
  activeDragId?: string | null;
  /** Pane ID currently being dragged over */
  dragOverPaneId?: string | null;
}

export const PaneSplitContainer = memo(function PaneSplitContainer({
  split,
  containerId,
  environmentId,
  isActive,
  activeDragId,
  dragOverPaneId,
}: PaneSplitContainerProps) {
  // Use a selector to only get the updateSizes function - this prevents re-renders
  // when other parts of the store change
  const updateSizes = usePaneLayoutStore((state) => state.updateSizes);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the split.id to detect changes during debounce
  const splitIdRef = useRef(split.id);

  const [firstChild, secondChild] = split.children;
  const firstPanelId = `panel-${firstChild.id}`;
  const secondPanelId = `panel-${secondChild.id}`;

  // Cleanup debounce timeout on unmount or when split.id changes
  // This prevents updating the wrong split if the tree structure changes during resize
  useEffect(() => {
    // If split.id changed, cancel any pending debounced update for the old split
    if (splitIdRef.current !== split.id) {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }
      splitIdRef.current = split.id;
    }

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [split.id]);

  // Debounced layout change handler - only update store after drag settles
  // This prevents excessive re-renders during drag which can interrupt the drag operation
  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      const firstSize = layout[firstPanelId];
      const secondSize = layout[secondPanelId];

      if (firstSize !== undefined && secondSize !== undefined) {
        // Clear any pending update
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }

        // Debounce the store update to avoid re-renders during drag
        debounceTimeoutRef.current = setTimeout(() => {
          updateSizes(split.id, [firstSize, secondSize], environmentId);
        }, RESIZE_DEBOUNCE_MS);
      }
    },
    [environmentId, split.id, firstPanelId, secondPanelId, updateSizes]
  );

  return (
    <ResizablePanelGroup
      orientation={split.direction}
      onLayoutChange={handleLayoutChange}
    >
      <ResizablePanel
        id={firstPanelId}
        defaultSize={split.sizes[0]}
        minSize={10}
        className="min-h-0 min-w-0"
      >
        <PaneTree
          node={firstChild}
          containerId={containerId}
          environmentId={environmentId}
          isActive={isActive}
          activeDragId={activeDragId}
          dragOverPaneId={dragOverPaneId}
        />
      </ResizablePanel>

      <ResizableHandle orientation={split.direction} />

      <ResizablePanel
        id={secondPanelId}
        defaultSize={split.sizes[1]}
        minSize={10}
        className="min-h-0 min-w-0"
      >
        <PaneTree
          node={secondChild}
          containerId={containerId}
          environmentId={environmentId}
          isActive={isActive}
          activeDragId={activeDragId}
          dragOverPaneId={dragOverPaneId}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
});
