import { memo, useCallback, useRef, useEffect } from "react";
import { type Layout } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks";
import { usePaneLayoutStore } from "@/stores";
import { isPaneLeaf, type PaneLeaf, type PaneNode, type PaneSplit } from "@/types/paneLayout";
import { PaneTree } from "./PaneTree";
import { MobilePaneSwitcher } from "./MobilePaneSwitcher";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

/** Debounce delay for store updates during resize operations (ms) */
const RESIZE_DEBOUNCE_MS = 100;

export function collectPaneLeaves(node: PaneNode): PaneLeaf[] {
  if (isPaneLeaf(node)) return [node];
  return [...collectPaneLeaves(node.children[0]), ...collectPaneLeaves(node.children[1])];
}

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
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Use a selector to only get the updateSizes function - this prevents re-renders
  // when other parts of the store change
  const updateSizes = usePaneLayoutStore((state) => state.updateSizes);
  const setActivePane = usePaneLayoutStore((state) => state.setActivePane);
  const activePaneId = usePaneLayoutStore(
    (state) => state.environments.get(environmentId)?.activePaneId,
  );
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

  if (isMobile) {
    const panes = collectPaneLeaves(split);
    const paneById = new Map(panes.map((pane) => [pane.id, pane]));
    return (
      <MobilePaneSwitcher
        panes={panes.map((pane) => {
          const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
          return {
            id: pane.id,
            label: activeTab?.displayTitle ?? activeTab?.type ?? "Empty pane",
          };
        })}
        activePaneId={activePaneId}
        onSelect={(paneId) => setActivePane(paneId, environmentId)}
        renderPane={(paneId, paneIsActive) => (
          <PaneTree
            node={paneById.get(paneId)!}
            containerId={containerId}
            environmentId={environmentId}
            isActive={isActive && paneIsActive}
            activeDragId={activeDragId}
            dragOverPaneId={dragOverPaneId}
          />
        )}
      />
    );
  }

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
