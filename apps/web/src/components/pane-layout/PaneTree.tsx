import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { type Layout } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks";
import { usePaneLayoutStore } from "@/stores";
import {
  isPaneLeaf,
  isPaneSplit,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
} from "@/types/paneLayout";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/components/layout/MobileAppShellLayout";
import { MobilePaneSwitcher, selectMobilePaneId } from "./MobilePaneSwitcher";
import { PaneLeafContainer } from "./PaneLeafContainer";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useStablePaneHosts, type StablePaneHosts } from "./useStablePaneHosts";
import { getWorkflowTabTitle } from "./workflow-tab-title";

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

/** Positions panes; their content is rendered once by `PaneTree`. */
const PaneSlotContext = createContext<StablePaneHosts["slot"] | null>(null);

function usePaneSlot(): StablePaneHosts["slot"] {
  const slot = useContext(PaneSlotContext);
  if (!slot) throw new Error("Pane layout rendered outside PaneTree");
  return slot;
}

/**
 * An environment's panes.
 *
 * Every pane renders once, into a stable host, and the layout only positions
 * those hosts: nested resizable groups on desktop, a pane switcher below the
 * mobile breakpoint. Crossing the breakpoint or splitting a pane therefore
 * moves panes rather than remounting them, so their dialogs, drafts and
 * terminal attachments survive.
 */
export const PaneTree = memo(function PaneTree({
  node,
  containerId,
  environmentId,
  isActive,
  activeDragId,
  dragOverPaneId,
}: PaneTreeProps) {
  const isMobile = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const setActivePane = usePaneLayoutStore((state) => state.setActivePane);
  const activePaneId = usePaneLayoutStore(
    (state) => state.environments.get(environmentId)?.activePaneId,
  );
  const leaves = useMemo(() => collectPaneLeaves(node), [node]);
  const hosts = useStablePaneHosts(useMemo(() => leaves.map((leaf) => leaf.id), [leaves]));
  const split = isPaneSplit(node) ? node : null;
  // Only one pane is on screen in the switcher; the others stay mounted but
  // must not act as the visible tab.
  const switcherPaneId = isMobile && split ? selectMobilePaneId(leaves, activePaneId) : null;

  return (
    <PaneSlotContext.Provider value={hosts.slot}>
      {hosts.park}
      {split && isMobile ? (
        <MobilePaneSwitcher
          panes={mobilePaneOptions(split)}
          activePaneId={activePaneId}
          onSelect={(paneId) => setActivePane(paneId, environmentId)}
          renderPane={(paneId) => hosts.slot(paneId)}
        />
      ) : (
        <PaneNodeLayout node={node} environmentId={environmentId} />
      )}
      {leaves.map((leaf) =>
        hosts.portal(
          leaf.id,
          <PaneLeafContainer
            pane={leaf}
            containerId={containerId}
            environmentId={environmentId}
            isActive={isActive && (switcherPaneId === null || switcherPaneId === leaf.id)}
            hiddenByLayout={isActive && switcherPaneId !== null && switcherPaneId !== leaf.id}
            activeDragId={activeDragId}
            dragOverPaneId={dragOverPaneId}
          />,
        ),
      )}
    </PaneSlotContext.Provider>
  );
});

function PaneNodeLayout({ node, environmentId }: { node: PaneNode; environmentId: string }) {
  const slot = usePaneSlot();
  if (isPaneLeaf(node)) return slot(node.id);
  return <PaneSplitContainer split={node} environmentId={environmentId} />;
}

/** Debounce delay for store updates during resize operations (ms) */
const RESIZE_DEBOUNCE_MS = 100;

export function collectPaneLeaves(node: PaneNode): PaneLeaf[] {
  if (isPaneLeaf(node)) return [node];
  return [...collectPaneLeaves(node.children[0]), ...collectPaneLeaves(node.children[1])];
}

export function mobilePaneOptions(split: PaneSplit): Array<{ id: string; label: string }> {
  return collectPaneLeaves(split).map((pane) => {
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
    return {
      id: pane.id,
      label: activeTab
        ? (getWorkflowTabTitle(activeTab) ?? activeTab.displayTitle ?? activeTab.type)
        : "Empty pane",
    };
  });
}

interface PaneSplitContainerProps {
  split: PaneSplit;
  environmentId: string;
}

/** The desktop layout of one split: two resizable panels. */
export const PaneSplitContainer = memo(function PaneSplitContainer({
  split,
  environmentId,
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
    [environmentId, split.id, firstPanelId, secondPanelId, updateSizes],
  );

  return (
    <ResizablePanelGroup orientation={split.direction} onLayoutChange={handleLayoutChange}>
      <ResizablePanel
        id={firstPanelId}
        defaultSize={split.sizes[0]}
        minSize={10}
        className="min-h-0 min-w-0"
      >
        <PaneNodeLayout node={firstChild} environmentId={environmentId} />
      </ResizablePanel>

      <ResizableHandle orientation={split.direction} />

      <ResizablePanel
        id={secondPanelId}
        defaultSize={split.sizes[1]}
        minSize={10}
        className="min-h-0 min-w-0"
      >
        <PaneNodeLayout node={secondChild} environmentId={environmentId} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
});
