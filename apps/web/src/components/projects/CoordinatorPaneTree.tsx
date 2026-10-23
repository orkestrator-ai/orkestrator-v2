import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type Layout } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks";
import { cn } from "@/lib/utils";
import {
  collectCoordinatorLeaves,
  findCoordinatorLeaf,
  moveCoordinatorConversation,
  reorderCoordinatorConversations,
  resizeCoordinatorSplit,
  splitCoordinatorPaneAtEdge,
  type CoordinatorPaneLayout,
  type CoordinatorPaneLeaf,
  type CoordinatorPaneNode,
  type CoordinatorPaneSplit,
} from "@/lib/coordinator-pane-layout";
import {
  createDraggableTabId,
  createTabbarDroppableId,
  parseDraggableTabId,
} from "@/types/paneLayout";
import {
  customCollisionDetection,
  getTerminalTabDragEndAction,
} from "@/components/terminal/TerminalContainer.helpers";
import { DropZoneOverlay } from "@/components/pane-layout/DropZoneOverlay";
import { MobilePaneSwitcher } from "@/components/pane-layout/MobilePaneSwitcher";
import { TAB_STRIP_CLASS, TabShell } from "@/components/pane-layout/TabShell";
import {
  useStablePaneHosts,
  type StablePaneHosts,
} from "@/components/pane-layout/useStablePaneHosts";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/components/layout/MobileAppShellLayout";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

/**
 * Coordinator conversations as tab groups.
 *
 * The same interaction as an environment's panes — drag a tab onto another
 * strip to move it, onto a pane edge to split — built from the same drop zones,
 * collision rules, and drag-end decisions. Only the tab and pane contents come
 * from the coordinator page. Like `PaneTree`, each group renders once into a
 * stable host that the layout only positions, so crossing the mobile breakpoint
 * or splitting a group keeps conversation drafts and scroll positions.
 */

interface CoordinatorPaneTreeProps {
  layout: CoordinatorPaneLayout;
  /** Applies a layout change. Called with an updater so it composes with the latest state. */
  onLayoutChange: (change: (layout: CoordinatorPaneLayout) => CoordinatorPaneLayout) => void;
  onFocusPane: (paneId: string) => void;
  renderTab: (conversationId: string, pane: CoordinatorPaneLeaf, isFocused: boolean) => ReactNode;
  /** Trailing strip controls, such as the new-conversation action. */
  renderStripActions: (pane: CoordinatorPaneLeaf) => ReactNode;
  renderContent: (pane: CoordinatorPaneLeaf, isFocused: boolean) => ReactNode;
  /** Mobile pane switcher label for a conversation. */
  conversationLabel: (conversationId: string) => string;
}

interface PaneTreeContextValue extends Omit<CoordinatorPaneTreeProps, "layout"> {
  activePaneId: string;
  isSplit: boolean;
  activeDragId: string | null;
  dragOverPaneId: string | null;
  slot: StablePaneHosts["slot"];
}

const PaneTreeContext = createContext<PaneTreeContextValue | null>(null);

function usePaneTree(): PaneTreeContextValue {
  const value = useContext(PaneTreeContext);
  if (!value) throw new Error("Coordinator pane used outside CoordinatorPaneTree");
  return value;
}

export function CoordinatorPaneTree({ layout, ...props }: CoordinatorPaneTreeProps) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);
  // Pointer only: the keyboard sensor claims Enter and Space, which select a tab here.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const { onLayoutChange } = props;
  const leaves = useMemo(() => collectCoordinatorLeaves(layout.root), [layout.root]);
  const hosts = useStablePaneHosts(useMemo(() => leaves.map((leaf) => leaf.id), [leaves]));

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over ? String(event.over.id) : null;
    if (overId?.startsWith("tabbar:")) {
      setDragOverPaneId(overId.slice("tabbar:".length));
      return;
    }
    setDragOverPaneId(overId ? (parseDraggableTabId(overId)?.paneId ?? null) : null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const lastDragOverPaneId = dragOverPaneId;
      setActiveDragId(null);
      setDragOverPaneId(null);
      const action = getTerminalTabDragEndAction({
        activeId: String(event.active.id),
        overId: event.over ? String(event.over.id) : null,
        lastDragOverPaneId,
        getPane: (paneId) => {
          const leaf = findCoordinatorLeaf(layout.root, paneId);
          return leaf ? { tabs: leaf.conversationIds.map((id) => ({ id })) } : null;
        },
      });
      if (action.type === "split") {
        onLayoutChange((current) =>
          splitCoordinatorPaneAtEdge(
            current,
            action.targetPaneId,
            action.edge,
            action.tabId,
            action.fromPaneId,
          ),
        );
      } else if (action.type === "move") {
        onLayoutChange((current) =>
          moveCoordinatorConversation(
            current,
            action.fromPaneId,
            action.toPaneId,
            action.tabId,
            action.toIndex,
          ),
        );
      } else if (action.type === "reorder") {
        onLayoutChange((current) =>
          reorderCoordinatorConversations(current, action.paneId, action.fromIndex, action.toIndex),
        );
      }
    },
    [dragOverPaneId, layout.root, onLayoutChange],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setDragOverPaneId(null);
  }, []);

  // The render props are recreated by the page on every render, so memoizing
  // this would only add a comparison.
  const context: PaneTreeContextValue = {
    ...props,
    activePaneId: layout.activePaneId,
    isSplit: layout.root.kind === "split",
    activeDragId,
    dragOverPaneId,
    slot: hosts.slot,
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={customCollisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <PaneTreeContext.Provider value={context}>
        {hosts.park}
        <PaneNodeView node={layout.root} />
        {leaves.map((leaf) => hosts.portal(leaf.id, <PaneLeafView pane={leaf} />))}
      </PaneTreeContext.Provider>
    </DndContext>
  );
}

function PaneNodeView({ node }: { node: CoordinatorPaneNode }) {
  const { slot } = usePaneTree();
  return node.kind === "leaf" ? slot(node.id) : <PaneSplitView split={node} />;
}

/** Debounce delay for persisting sizes while a divider is dragged (ms). */
const RESIZE_DEBOUNCE_MS = 100;

function PaneSplitView({ split }: { split: CoordinatorPaneSplit }) {
  const { activePaneId, onFocusPane, onLayoutChange, conversationLabel, slot } = usePaneTree();
  const isMobile = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [first, second] = split.children;
  const firstPanelId = `panel-${first.id}`;
  const secondPanelId = `panel-${second.id}`;

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [split.id],
  );

  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      const firstSize = layout[firstPanelId];
      const secondSize = layout[secondPanelId];
      if (firstSize === undefined || secondSize === undefined) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onLayoutChange((current) =>
          resizeCoordinatorSplit(current, split.id, [firstSize, secondSize]),
        );
      }, RESIZE_DEBOUNCE_MS);
    },
    [firstPanelId, onLayoutChange, secondPanelId, split.id],
  );

  if (isMobile) {
    const panes = collectCoordinatorLeaves(split);
    return (
      <MobilePaneSwitcher
        panes={panes.map((pane) => ({
          id: pane.id,
          label: pane.activeConversationId
            ? conversationLabel(pane.activeConversationId)
            : "Empty pane",
        }))}
        activePaneId={activePaneId}
        onSelect={onFocusPane}
        renderPane={(paneId) => slot(paneId)}
      />
    );
  }

  return (
    <ResizablePanelGroup orientation={split.direction} onLayoutChange={handleLayoutChange}>
      <ResizablePanel
        id={firstPanelId}
        defaultSize={split.sizes[0]}
        minSize={10}
        className="min-h-0 min-w-0"
      >
        <PaneNodeView node={first} />
      </ResizablePanel>
      <ResizableHandle orientation={split.direction} />
      <ResizablePanel
        id={secondPanelId}
        defaultSize={split.sizes[1]}
        minSize={10}
        className="min-h-0 min-w-0"
      >
        <PaneNodeView node={second} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function PaneLeafView({ pane }: { pane: CoordinatorPaneLeaf }) {
  const {
    activePaneId,
    isSplit,
    activeDragId,
    dragOverPaneId,
    onFocusPane,
    renderTab,
    renderStripActions,
    renderContent,
  } = usePaneTree();
  const { setNodeRef, isOver } = useDroppable({ id: createTabbarDroppableId(pane.id) });
  const isFocused = activePaneId === pane.id;

  // A tab dragged in from another group joins this strip's sortable items so
  // the strip makes room for it while it hovers.
  const sortableIds = useMemo(() => {
    const ids: string[] = pane.conversationIds.map((id) => createDraggableTabId(id, pane.id));
    if (activeDragId && dragOverPaneId === pane.id) {
      const dragged = parseDraggableTabId(activeDragId);
      if (dragged && dragged.paneId !== pane.id) ids.push(activeDragId);
    }
    return ids;
  }, [activeDragId, dragOverPaneId, pane.conversationIds, pane.id]);

  return (
    <div
      data-coordinator-pane={pane.id}
      className={cn(
        "relative flex h-full w-full min-h-0 flex-col overflow-hidden bg-background",
        // Which group the composer and shortcuts belong to only needs marking
        // once there is more than one.
        isSplit && isFocused && "ring-1 ring-primary/20",
      )}
      onPointerDownCapture={() => onFocusPane(pane.id)}
      onFocusCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocusPane(pane.id);
      }}
      onClick={() => onFocusPane(pane.id)}
    >
      <div
        ref={setNodeRef}
        className={cn(TAB_STRIP_CLASS, "shrink-0 pr-2", isOver && "bg-primary/10")}
      >
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
          {pane.conversationIds.map((id) => renderTab(id, pane, isFocused))}
        </SortableContext>
        {renderStripActions(pane)}
      </div>
      <div className="relative min-h-0 flex-1">
        {renderContent(pane, isFocused)}
        <DropZoneOverlay paneId={pane.id} />
      </div>
    </div>
  );
}

/** A coordinator tab that can be dragged between groups. */
export function SortableCoordinatorTab({
  conversationId,
  paneId,
  className,
  style,
  ...shell
}: ComponentProps<typeof TabShell> & { conversationId: string; paneId: string }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: createDraggableTabId(conversationId, paneId),
  });
  return (
    <TabShell
      ref={setNodeRef}
      style={{ ...style, transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(
        "cursor-grab active:cursor-grabbing",
        isDragging && "z-50 opacity-50",
        className,
      )}
      {...shell}
    />
  );
}
