import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useUpdateNodeInternals,
  type EdgeMouseHandler,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { GraphDesignerSelection } from "@/stores/graphDesignerStore";
import { cn } from "@/lib/utils";
import { GRAPH_CANVAS_NODE_TYPES } from "./GraphCanvasNodes";
import {
  GRAPH_TYPE_FAMILY_COLORS,
  type GraphCanvasEdge,
  type GraphCanvasModel,
  type GraphCanvasNode,
} from "./graph-designer-model";

/**
 * The read-only Graphs canvas (React Flow, item 110). Nodes cannot be dragged
 * or connected. Keyboard follows the flow graph's pattern: one tab stop (the
 * selected node, else the first), arrows and Home/End move through the nodes
 * in topological order, Enter or Space selects. Edges are not tab stops; the
 * inspector and the compile panel list them.
 */

const ERROR_STROKE = "#f87171";
/** The smallest zoom at which a face's title and ports can be read. */
export const GRAPH_READABLE_ZOOM = 0.6;
const VIEWPORT_MARGIN = 24;

interface GraphCanvasProps {
  model: GraphCanvasModel;
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

  const activeId =
    selection?.kind === "node" && model.order.includes(selection.id)
      ? selection.id
      : model.order[0];

  const nodes = useMemo<GraphCanvasNode[]>(
    () =>
      model.nodes.map((node) => {
        const selected = nodeSelected(node, selection);
        const size = measured.get(node.id);
        return {
          ...node,
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
    [model.nodes, selection, measured, activeId],
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
    if (sizes.length === 0) return;
    setMeasured((previous) => {
      const next = new Map(previous);
      for (const change of sizes) next.set(change.id, change.dimensions!);
      return next;
    });
  }, []);

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
    if (!id) return;
    const index = model.order.indexOf(id);
    if (index < 0) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect({ kind: "node", id });
      return;
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

  return (
    <div
      ref={wrapperRef}
      data-graph-canvas=""
      className={cn("graph-designer-canvas relative h-full min-h-0 w-full", className)}
      onKeyDown={onKeyDown}
    >
      <ReactFlow<GraphCanvasNode, GraphCanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={GRAPH_CANVAS_NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable={false}
        elementsSelectable={false}
        disableKeyboardA11y
        colorMode="dark"
        minZoom={0.15}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
        aria-label="Graph canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" className="@max-4xl:hidden" />
      </ReactFlow>
    </div>
  );
}
