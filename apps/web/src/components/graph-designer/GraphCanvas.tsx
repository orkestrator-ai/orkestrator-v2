import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useConnection,
  useNodesInitialized,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type EdgeMouseHandler,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
  type XYPosition,
} from "@xyflow/react";
import type { GraphTemplateSummary } from "@orkestrator/protocol/graphs/library";
import type { GraphLayoutPoint } from "@orkestrator/protocol/graphs/template";
import type { GraphDesignerSelection } from "@/stores/graphDesignerStore";
import { cn } from "@/lib/utils";
import { GRAPH_CANVAS_NODE_TYPES, GraphCanvasConnectContext } from "./GraphCanvasNodes";
import { GraphPalette } from "./GraphPalette";
import type { GraphConnectEnd, GraphConnectionVerdict } from "./graph-designer-connect";
import type { GraphPaletteItem } from "./graph-designer-edits";
import type { GraphSubgraphChoice } from "./graph-designer-subgraphs";
import { GRAPH_NODE_WIDTH } from "./graph-designer-layout";
import type { GraphEditorCommand } from "./graph-editor-context";
import {
  GRAPH_TYPE_FAMILY_COLORS,
  type GraphCanvasEdge,
  type GraphCanvasModel,
  type GraphCanvasNode,
} from "./graph-designer-model";

/**
 * The Graphs canvas (React Flow). Read-only (item 110) unless an `editor` is
 * given (item 212): then nodes drag (positions go to the template's layout),
 * ports connect (only compatible targets light up; see
 * `graph-designer-connect.ts`), the palette adds nodes, and dragging a node
 * onto a loop frame moves it into that loop (out of it, when dragged off a
 * frame that has other members).
 *
 * Keyboard follows the flow graph's pattern: one tab stop (the selected node,
 * else the first), arrows and Home/End move through the nodes in topological
 * order, Enter or Space selects. Editing adds Delete (remove the node, or the
 * selected edge), Shift+arrows (move the node), C ("Connect to…") and L
 * ("Move into loop"). Edges are not tab stops; the inspector and the compile
 * panel list them.
 */

const ERROR_STROKE = "#f87171";
/** The smallest zoom at which a face's title and ports can be read. */
export const GRAPH_READABLE_ZOOM = 0.6;
const VIEWPORT_MARGIN = 24;

/** What the editable canvas asks of the designer; every change is one undo step. */
export interface GraphCanvasEditor {
  verdict: (from: GraphConnectEnd, to: GraphConnectEnd) => GraphConnectionVerdict;
  connect: (verdict: Extract<GraphConnectionVerdict, { ok: true }>) => void;
  refuse: (reason: string) => void;
  /** Absolute positions, and loop membership changes (`null`: out of its loop). */
  move: (
    positions: Record<string, GraphLayoutPoint>,
    loops: Record<string, string | null>,
    options?: { coalesce?: string },
  ) => void;
  remove: (selection: NonNullable<GraphDesignerSelection>) => void;
  add: (item: GraphPaletteItem, position: GraphLayoutPoint) => void;
  /** Saved templates the palette offers as sub-graphs (item 402). */
  subgraphChoices?: readonly GraphSubgraphChoice[];
  /** Reads the picked template, then adds it as a sub-graph node. */
  addSubgraph?: (summary: GraphTemplateSummary, position: GraphLayoutPoint) => void;
  wrapInLoop: (nodeId: string) => void;
  command: (command: GraphEditorCommand, nodeId: string) => void;
}

/** Shift+arrow moves the focused node this far. */
const NUDGE = 20;

interface GraphCanvasProps {
  model: GraphCanvasModel;
  /** Present on the editable canvas (item 212). */
  editor?: GraphCanvasEditor;
  selection: GraphDesignerSelection;
  /** Bumped to bring the selection into view (and focus a selected node). */
  focusRequest: number;
  /** Whether the tab is visible; the first fit waits for it. */
  isActive: boolean;
  onSelect: (selection: GraphDesignerSelection) => void;
  className?: string;
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function edgeSelected(edge: GraphCanvasEdge, selection: GraphDesignerSelection): boolean {
  if (!selection || !edge.data) return false;
  if (selection.kind === "edge") return edge.data.kind === "edge" && edge.data.ref === selection.id;
  if (selection.kind === "loop")
    return edge.data.kind === "carry" && edge.data.ref === selection.id;
  return false;
}

function nodeSelected(node: GraphCanvasNode, selection: GraphDesignerSelection): boolean {
  if (!selection) return false;
  if (node.type === "graph-node") return selection.kind === "node" && selection.id === node.id;
  if (node.type === "graph-loop")
    return selection.kind === "loop" && selection.id === node.data.loopId;
  return false;
}

function GraphCanvasInner({
  model,
  editor,
  selection,
  focusRequest,
  isActive,
  onSelect,
  className,
}: GraphCanvasProps) {
  const flow = useReactFlow<GraphCanvasNode, GraphCanvasEdge>();
  const updateNodeInternals = useUpdateNodeInternals();
  const nodesInitialized = useNodesInitialized();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  // React Flow measures nodes and reports their sizes as changes; a
  // controlled flow must hand them back on the nodes it renders.
  const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(
    () => new Map(),
  );
  // Positions of nodes being dragged, until the drop writes them to the template.
  const [dragged, setDragged] = useState<Map<string, XYPosition>>(() => new Map());

  const activeId =
    selection?.kind === "node" && model.order.includes(selection.id)
      ? selection.id
      : model.order[0];

  const nodes = useMemo<GraphCanvasNode[]>(
    () =>
      model.nodes.map((node) => {
        const selected = nodeSelected(node, selection);
        const size = measured.get(node.id);
        const position = dragged.get(node.id);
        return {
          ...node,
          ...(position ? { position } : {}),
          ...(size ? { measured: size } : {}),
          selected,
          ...(node.type === "graph-node"
            ? {
                domAttributes: {
                  tabIndex: node.id === activeId ? 0 : -1,
                  "aria-pressed": selected,
                },
              }
            : {}),
        } as GraphCanvasNode;
      }),
    [model.nodes, selection, measured, dragged, activeId],
  );

  const edges = useMemo<GraphCanvasEdge[]>(
    () =>
      model.edges.map((edge) => {
        const data = edge.data!;
        const selected = edgeSelected(edge, selection);
        const failing = data.diagnostics.errors > 0;
        const color = failing ? ERROR_STROKE : GRAPH_TYPE_FAMILY_COLORS[data.family];
        return {
          ...edge,
          selected,
          focusable: false,
          className: cn(
            failing && "graph-edge-error",
            data.diagnostics.warnings > 0 && !failing && "graph-edge-warning",
          ),
          style: {
            stroke: color,
            strokeWidth: selected ? 3 : failing ? 2.5 : 1.5,
            ...(data.kind === "carry" ? { strokeDasharray: "6 4" } : {}),
            ...(data.kind === "output" ? { strokeDasharray: "2 3" } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          labelStyle: { fill: "var(--color-muted-foreground)", fontSize: 10 },
          labelBgStyle: { fill: "var(--color-flow-canvas)" },
          ...(failing ? { domAttributes: { "data-graph-diagnostics": "error" } } : {}),
        } as GraphCanvasEdge;
      }),
    [model.edges, selection],
  );

  const onNodesChange = useCallback((changes: NodeChange<GraphCanvasNode>[]) => {
    const sizes = changes.filter(
      (change): change is Extract<NodeChange<GraphCanvasNode>, { type: "dimensions" }> =>
        change.type === "dimensions" && Boolean(change.dimensions),
    );
    if (sizes.length > 0) {
      setMeasured((previous) => {
        const next = new Map(previous);
        for (const change of sizes) next.set(change.id, change.dimensions!);
        return next;
      });
    }
    const moves = changes.filter(
      (change): change is Extract<NodeChange<GraphCanvasNode>, { type: "position" }> =>
        change.type === "position" && Boolean(change.position),
    );
    if (moves.length > 0) {
      setDragged((previous) => {
        const next = new Map(previous);
        for (const change of moves) next.set(change.id, change.position!);
        return next;
      });
    }
  }, []);

  // A new model carries the dropped positions; the overlay is no longer needed.
  const [overlayModel, setOverlayModel] = useState(model);
  if (overlayModel !== model) {
    setOverlayModel(model);
    if (dragged.size > 0) setDragged(new Map());
  }

  const absolute = useCallback(
    (relative: XYPosition, parentId: string | undefined): XYPosition => {
      if (!parentId) return relative;
      const parent = flow.getInternalNode(parentId);
      const origin = dragged.get(parentId) ?? parent?.internals.positionAbsolute ?? { x: 0, y: 0 };
      return { x: origin.x + relative.x, y: origin.y + relative.y };
    },
    [flow, dragged],
  );

  /** Where a node dropped at `point` belongs: a loop it was dropped on, or out of its own. */
  const containment = useCallback(
    (id: string, point: XYPosition): string | null | undefined => {
      const size = flow.getInternalNode(id)?.measured;
      const center = {
        x: point.x + (size?.width ?? GRAPH_NODE_WIDTH) / 2,
        y: point.y + (size?.height ?? 100) / 2,
      };
      const inside = (box: { x: number; y: number; width: number; height: number }) =>
        center.x >= box.x &&
        center.x <= box.x + box.width &&
        center.y >= box.y &&
        center.y <= box.y + box.height;
      const node = model.nodes.find((candidate) => candidate.id === id);
      const current = node?.parentId?.startsWith("loop:") ? node.parentId.slice(5) : null;
      for (const [loopId, box] of model.layout.loops) {
        if (loopId !== current && inside(box)) return loopId;
      }
      if (current === null) return undefined;
      const own = model.layout.loops.get(current);
      const members = model.nodes.filter((candidate) => candidate.parentId === `loop:${current}`);
      // A loop's only member drags its frame along: a region needs a node.
      if (own && !inside(own) && members.length > 1) return null;
      return undefined;
    },
    [flow, model],
  );

  const onNodeDragStop: OnNodeDrag<GraphCanvasNode> = useCallback(
    (_event, _node, draggedNodes) => {
      if (!editor) return;
      const positions: Record<string, GraphLayoutPoint> = {};
      const loops: Record<string, string | null> = {};
      for (const node of draggedNodes) {
        if (node.type === "graph-node") {
          const point = absolute(node.position, node.parentId);
          positions[node.id] = point;
          const target = containment(node.id, point);
          if (target !== undefined) loops[node.id] = target;
        } else if (node.type === "graph-loop") {
          // Members keep their place in the frame; they move with it.
          for (const member of model.nodes) {
            if (member.parentId !== node.id) continue;
            positions[member.id] = {
              x: node.position.x + member.position.x,
              y: node.position.y + member.position.y,
            };
          }
        }
      }
      if (Object.keys(positions).length > 0) editor.move(positions, loops);
    },
    [editor, absolute, containment, model.nodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editor) return;
      const verdict = editor.verdict(
        { node: connection.source, handle: connection.sourceHandle ?? "" },
        { node: connection.target, handle: connection.targetHandle ?? "" },
      );
      if (verdict.ok) editor.connect(verdict);
      else editor.refuse(verdict.reason);
    },
    [editor],
  );

  const isValidConnection = useCallback(
    (connection: Connection | GraphCanvasEdge) =>
      editor
        ? editor.verdict(
            { node: connection.source, handle: connection.sourceHandle ?? "" },
            { node: connection.target, handle: connection.targetHandle ?? "" },
          ).ok
        : false,
    [editor],
  );

  const connectContext = useMemo(() => (editor ? { verdict: editor.verdict } : null), [editor]);

  /** The centre of the visible canvas, for nodes added from the palette. */
  const viewportCenter = useCallback((): GraphLayoutPoint => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const center = rect
      ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
    // Cascade, so repeated adds do not stack exactly.
    const taken = model.nodes.filter(
      (node) =>
        Math.abs(node.position.x - center.x) < 30 && Math.abs(node.position.y - center.y) < 30,
    ).length;
    return {
      x: center.x - GRAPH_NODE_WIDTH / 2 + taken * 30,
      y: center.y - 60 + taken * 30,
    };
  }, [flow, model.nodes]);

  // Ports may move inside a face without changing its size.
  useEffect(() => {
    updateNodeInternals(model.nodes.map((node) => node.id));
  }, [model, updateNodeInternals]);

  // Fit once the tab is visible and the nodes have been measured. A graph too
  // wide to read when fitted (a long pipeline) opens at a readable zoom on
  // its start instead; the minimap and controls reach the rest.
  useEffect(() => {
    if (!isActive || !nodesInitialized || fittedRef.current) return;
    fittedRef.current = true;
    void flow.fitView({ padding: 0.12, maxZoom: 1 }).then(() => {
      if (flow.getZoom() >= GRAPH_READABLE_ZOOM) return;
      const bounds = flow.getNodesBounds(flow.getNodes());
      const height = wrapperRef.current?.clientHeight ?? 0;
      const zoom = GRAPH_READABLE_ZOOM;
      const tall = bounds.height * zoom + 2 * VIEWPORT_MARGIN > height;
      void flow.setViewport({
        x: VIEWPORT_MARGIN - bounds.x * zoom,
        y: tall
          ? VIEWPORT_MARGIN - bounds.y * zoom
          : height / 2 - (bounds.y + bounds.height / 2) * zoom,
        zoom,
      });
    });
  }, [flow, isActive, nodesInitialized]);

  const focusNode = useCallback((id: string) => {
    const element = wrapperRef.current?.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${id}"]`,
    );
    element?.focus({ preventScroll: true });
  }, []);

  /** Centres the given nodes, zooming in to a readable size if needed. */
  const reveal = useCallback(
    (ids: string[], duration = 200) => {
      const boxes = ids.flatMap((id) => {
        const node = flow.getInternalNode(id);
        if (!node) return [];
        const { x, y } = node.internals.positionAbsolute;
        return [{ x, y, width: node.measured.width ?? 0, height: node.measured.height ?? 0 }];
      });
      if (boxes.length === 0) return;
      const minX = Math.min(...boxes.map((box) => box.x));
      const minY = Math.min(...boxes.map((box) => box.y));
      const maxX = Math.max(...boxes.map((box) => box.x + box.width));
      const maxY = Math.max(...boxes.map((box) => box.y + box.height));
      void flow.setCenter((minX + maxX) / 2, (minY + maxY) / 2, {
        zoom: Math.max(flow.getZoom(), GRAPH_READABLE_ZOOM),
        duration,
      });
    },
    [flow],
  );

  // A selection made outside the canvas (the compile panel, the inspector).
  const lastFocusRef = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === lastFocusRef.current) return;
    lastFocusRef.current = focusRequest;
    if (!selection) return;
    if (selection.kind === "node") {
      reveal([selection.id]);
      focusNode(selection.id);
    } else if (selection.kind === "loop") {
      reveal([`loop:${selection.id}`]);
    } else {
      const edge = model.edges.find(
        (candidate) => candidate.data?.kind === "edge" && candidate.data.ref === selection.id,
      );
      if (edge) reveal([edge.source, edge.target]);
    }
  }, [focusRequest, selection, model.edges, reveal, focusNode]);

  const onNodeClick: NodeMouseHandler<GraphCanvasNode> = useCallback(
    (_event, node) => {
      if (node.type === "graph-node") onSelect({ kind: "node", id: node.id });
      else if (node.type === "graph-loop") onSelect({ kind: "loop", id: node.data.loopId });
    },
    [onSelect],
  );

  const onEdgeClick: EdgeMouseHandler<GraphCanvasEdge> = useCallback(
    (_event, edge) => {
      if (edge.data?.kind === "edge") onSelect({ kind: "edge", id: edge.data.ref });
      else if (edge.data?.kind === "carry") onSelect({ kind: "loop", id: edge.data.ref });
    },
    [onSelect],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = (event.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
    const id = element?.dataset.id;
    if (!id) {
      if (
        editor &&
        selection?.kind === "edge" &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        editor.remove(selection);
      }
      return;
    }
    const index = model.order.indexOf(id);
    if (index < 0) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect({ kind: "node", id });
      return;
    }
    if (editor && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        editor.remove({ kind: "node", id });
        return;
      }
      if (event.key === "c" || event.key === "C") {
        event.preventDefault();
        editor.command("connect", id);
        return;
      }
      if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        editor.command("loop", id);
        return;
      }
      if (event.shiftKey && event.key.startsWith("Arrow")) {
        event.preventDefault();
        const node = flow.getInternalNode(id);
        if (!node) return;
        const { x, y } = node.internals.positionAbsolute;
        const dx = event.key === "ArrowLeft" ? -NUDGE : event.key === "ArrowRight" ? NUDGE : 0;
        const dy = event.key === "ArrowUp" ? -NUDGE : event.key === "ArrowDown" ? NUDGE : 0;
        editor.move({ [id]: { x: x + dx, y: y + dy } }, {}, { coalesce: `nudge:${id}` });
        return;
      }
    }
    let target: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = index - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = model.order.length - 1;
    if (target === null) return;
    event.preventDefault();
    const next = model.order[Math.max(0, Math.min(model.order.length - 1, target))]!;
    onSelect({ kind: "node", id: next });
    reveal([next], 120);
    focusNode(next);
  };

  const selectedNode = selection?.kind === "node" ? selection.id : null;
  return (
    <div
      ref={wrapperRef}
      data-graph-canvas=""
      data-graph-canvas-editable={editor ? "" : undefined}
      className={cn("graph-designer-canvas relative h-full min-h-0 w-full", className)}
      onKeyDown={onKeyDown}
    >
      <GraphCanvasConnectContext.Provider value={connectContext}>
        <ReactFlow<GraphCanvasNode, GraphCanvasEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={GRAPH_CANVAS_NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={() => onSelect(null)}
          {...(editor ? { onConnect, isValidConnection, onNodeDragStop, deleteKeyCode: null } : {})}
          nodesDraggable={Boolean(editor)}
          nodesConnectable={Boolean(editor)}
          nodesFocusable
          edgesFocusable={false}
          elementsSelectable={false}
          disableKeyboardA11y
          colorMode="dark"
          minZoom={0.15}
          maxZoom={1.75}
          proOptions={{ hideAttribution: true }}
          aria-label={editor ? "Graph canvas (editable)" : "Graph canvas"}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" className="@max-4xl:hidden" />
          {editor ? (
            <>
              <Panel position="top-left">
                <GraphPalette
                  onAdd={(item) => editor.add(item, viewportCenter())}
                  wrapTarget={selectedNode}
                  onWrapInLoop={(nodeId) => editor.wrapInLoop(nodeId)}
                  {...(editor.subgraphChoices ? { subgraphs: editor.subgraphChoices } : {})}
                  {...(editor.addSubgraph
                    ? {
                        onAddSubgraph: (summary: GraphTemplateSummary) =>
                          editor.addSubgraph?.(summary, viewportCenter()),
                      }
                    : {})}
                />
              </Panel>
              <Panel position="bottom-center">
                <ConnectionHint editor={editor} />
              </Panel>
            </>
          ) : null}
        </ReactFlow>
      </GraphCanvasConnectContext.Provider>
    </div>
  );
}

/** While a connection is dragged over a handle: what it would become, or why not. */
function ConnectionHint({ editor }: { editor: GraphCanvasEditor }) {
  const ends = useConnection((connection) =>
    connection.inProgress && connection.fromHandle && connection.toHandle && connection.toNode
      ? {
          fromNode: connection.fromNode.id,
          fromHandle: connection.fromHandle.id ?? "",
          toNode: connection.toNode.id,
          toHandle: connection.toHandle.id ?? "",
        }
      : null,
  );
  if (!ends || !("fromNode" in ends)) return null;
  const verdict = editor.verdict(
    { node: ends.fromNode, handle: ends.fromHandle },
    { node: ends.toNode, handle: ends.toHandle },
  );
  return (
    <p
      role="status"
      data-graph-connection-hint={verdict.ok ? "ok" : "refused"}
      className={cn(
        "rounded-md border px-2 py-1 text-[11px] shadow-sm",
        verdict.ok
          ? "border-indigo-400/50 bg-flow-node text-foreground"
          : "border-failure/50 bg-flow-node text-failure",
      )}
    >
      {verdict.ok ? verdict.summary : verdict.reason}
    </p>
  );
}
