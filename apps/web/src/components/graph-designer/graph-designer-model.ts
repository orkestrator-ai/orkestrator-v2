import type { Edge, Node } from "@xyflow/react";
import {
  graphPlanValueTypeLabel,
  type CompiledGraphPlan,
  type GraphCompileDiagnostic,
  type GraphPlanNode,
  type GraphPlanValueType,
} from "@orkestrator/protocol/graphs/compile";
import {
  graphNodeOutlets,
  isGraphRunInputRef,
  type GraphEdgeSource,
  type GraphEnforcementTier,
  type GraphNodeKind,
  type GraphNodeSpec,
  type GraphReplicate,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import { GRAPH_SYSTEM_ACTION_SPECS } from "@orkestrator/protocol/graphs/system-actions";
import {
  GraphTypeLibrary,
  graphTypeFamily,
  type GraphTypeFamily,
} from "@orkestrator/protocol/graphs/types";
import {
  GRAPH_INPUTS_NODE_ID,
  GRAPH_OUTPUTS_NODE_ID,
  layoutGraphTemplate,
  type GraphDesignerLayout,
} from "./graph-designer-layout";

/**
 * The Graphs designer's projection of a template (plus, when it compiled, its
 * plan and diagnostics) onto React Flow nodes and edges. Pure: the canvas, the
 * inspector and the tests read the same model, and item 212's editable canvas
 * reuses it.
 *
 * Handles are `in:<port>` and `out:<port>` (typed ports), and `outlet:<name>`
 * on gate and human nodes, whose outlets forward the node's inputs. Run inputs
 * and outputs are two pseudo-nodes, `$inputs` and `$outputs`. Each loop region
 * is a `group` node that its members name as `parentId`.
 */

/** Port and edge colour per type family (report §5.10), as literal colours. */
export const GRAPH_TYPE_FAMILY_COLORS: Readonly<Record<GraphTypeFamily, string>> = Object.freeze({
  text: "#38bdf8",
  ticket: "#fbbf24",
  report: "#a78bfa",
  workspace: "#34d399",
  decision: "#f472b6",
  package: "#2dd4bf",
  error: "#f87171",
  list: "#818cf8",
  unknown: "#71717a",
});

export const GRAPH_TYPE_FAMILY_LABELS: Readonly<Record<GraphTypeFamily, string>> = Object.freeze({
  text: "Text",
  ticket: "Ticket",
  report: "Report",
  workspace: "Workspace",
  decision: "Decision",
  package: "Package",
  error: "Error",
  list: "List",
  unknown: "Unresolved",
});

export const GRAPH_ENFORCEMENT_LABELS: Readonly<Record<GraphEnforcementTier, string>> =
  Object.freeze({
    enforced: "Enforced",
    "provider-configured": "Provider-configured",
    advisory: "Advisory",
  });

export const GRAPH_NODE_KIND_LABELS: Readonly<Record<GraphNodeKind, string>> = Object.freeze({
  agent: "Agent",
  system: "System",
  gate: "Gate",
  merge: "Merge",
  human: "Human",
  subgraph: "Sub-graph",
});

// ---------------------------------------------------------------- diagnostics

export interface GraphDiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export const NO_GRAPH_DIAGNOSTICS: GraphDiagnosticCounts = Object.freeze({
  errors: 0,
  warnings: 0,
  infos: 0,
});

export function graphDiagnosticCounts(
  list: readonly Pick<GraphCompileDiagnostic, "severity">[],
): GraphDiagnosticCounts {
  const counts = { errors: 0, warnings: 0, infos: 0 };
  for (const diagnostic of list) {
    if (diagnostic.severity === "error") counts.errors += 1;
    else if (diagnostic.severity === "warning") counts.warnings += 1;
    else counts.infos += 1;
  }
  return counts;
}

/** Diagnostics by what they are pinned to; one with none of the three is `general`. */
export interface GraphDiagnosticIndex {
  nodes: Map<string, GraphCompileDiagnostic[]>;
  edges: Map<string, GraphCompileDiagnostic[]>;
  loops: Map<string, GraphCompileDiagnostic[]>;
  general: GraphCompileDiagnostic[];
}

function push<K>(map: Map<K, GraphCompileDiagnostic[]>, key: K, value: GraphCompileDiagnostic) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Pins each diagnostic to its node, edge and loop. A diagnostic may name more
 * than one (an edge's port check names the edge and its target node), and it
 * is listed under each.
 */
export function indexGraphDiagnostics(
  diagnostics: readonly GraphCompileDiagnostic[],
): GraphDiagnosticIndex {
  const index: GraphDiagnosticIndex = {
    nodes: new Map(),
    edges: new Map(),
    loops: new Map(),
    general: [],
  };
  for (const diagnostic of diagnostics) {
    if (diagnostic.nodeId) push(index.nodes, diagnostic.nodeId, diagnostic);
    if (diagnostic.edgeId) push(index.edges, diagnostic.edgeId, diagnostic);
    if (diagnostic.loopId) push(index.loops, diagnostic.loopId, diagnostic);
    if (!diagnostic.nodeId && !diagnostic.edgeId && !diagnostic.loopId) {
      index.general.push(diagnostic);
    }
  }
  return index;
}

// ---------------------------------------------------------------- types

/** The family of a plan value type: lists are `list`, an edge's anonymous shape a `report`. */
export function graphPlanValueTypeFamily(
  type: GraphPlanValueType | null | undefined,
  library: GraphTypeLibrary,
): GraphTypeFamily {
  if (!type) return "unknown";
  if (type.kind === "list") return "list";
  if (type.kind === "shape") return "report";
  return graphTypeFamily(type.ref, library);
}

/** The template's own types beside the built-ins; conflicts are the compiler's to report. */
export function graphTemplateTypeLibrary(template: GraphTemplateV1): GraphTypeLibrary {
  return new GraphTypeLibrary(template.types ?? []);
}

// ---------------------------------------------------------------- views

export interface GraphDesignerPortView {
  name: string;
  /** The declared reference, `name@major` or `list<…>`. */
  type: string;
  family: GraphTypeFamily;
  label?: string;
  required: boolean;
  handleId: string;
}

export interface GraphDesignerOutletView {
  name: string;
  handleId: string;
}

export type GraphCanvasNodeData = {
  nodeId: string;
  kind: GraphNodeKind;
  title: string;
  /** Row 2 of the face: `{role} · {profile}` for agents, the action, strategy or form otherwise. */
  detail: string;
  /** The node's effective enforcement floor (agents), when it has one. */
  enforcement?: GraphEnforcementTier;
  /** The replication badge, such as `×3`, `×panel` or `×1–32`. */
  replication?: string;
  /** A system node whose action changes something outside the run (its spec's `sideEffect`). */
  sideEffect?: boolean;
  inputs: GraphDesignerPortView[];
  outputs: GraphDesignerPortView[];
  outlets: GraphDesignerOutletView[];
  diagnostics: GraphDiagnosticCounts;
  ariaLabel: string;
  /** Editable canvas: a `+` handle that adds an input of the connected type. */
  newInput?: boolean;
};

export type GraphIoNodeData = {
  direction: "inputs" | "outputs";
  ports: GraphDesignerPortView[];
  /** Editable canvas: `$outputs` takes a `+` handle that adds a run output. */
  newPort?: boolean;
};

export type GraphLoopNodeData = {
  loopId: string;
  label: string;
  maxIterations: number;
  diagnostics: GraphDiagnosticCounts;
};

export type GraphCanvasTemplateNode = Node<GraphCanvasNodeData, "graph-node">;
export type GraphCanvasIoNode = Node<GraphIoNodeData, "graph-io">;
export type GraphCanvasLoopNode = Node<GraphLoopNodeData, "graph-loop">;
export type GraphCanvasNode = GraphCanvasTemplateNode | GraphCanvasIoNode | GraphCanvasLoopNode;

export type GraphCanvasEdgeData = {
  /** `edge`: a template edge; `carry`: a loop carry; `output`: a run output. */
  kind: "edge" | "carry" | "output";
  family: GraphTypeFamily;
  /** The delivered type when compiled, else the producer's declared type. */
  typeLabel: string;
  diagnostics: GraphDiagnosticCounts;
  /** Template edge id (`edge`), loop id (`carry`) or run output name (`output`). */
  ref: string;
};

export type GraphCanvasEdge = Edge<GraphCanvasEdgeData>;

export interface GraphCanvasModel {
  /** Loop groups first (parents precede children), then nodes, then the I/O pseudo-nodes. */
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  /** Template node ids in keyboard order: the plan's topological order when compiled. */
  order: string[];
  layout: GraphDesignerLayout;
  /** Template edges that could not be drawn (a missing node or port); the compiler says why. */
  undrawnEdges: string[];
  diagnostics: GraphDiagnosticIndex;
}

export function graphCarryEdgeId(loopId: string, index: number): string {
  return `carry:${loopId}#${index}`;
}

export function graphOutputEdgeId(name: string): string {
  return `output:${name}`;
}

/** The node's title on its face: its label, else its id. */
export function graphNodeTitle(node: Pick<GraphNodeSpec, "id" | "label">): string {
  return node.label?.trim() || node.id;
}

export function graphNodeDetail(node: GraphNodeSpec): string {
  switch (node.kind) {
    case "agent":
      return `${node.role} · ${node.capabilities.profile}`;
    case "system":
      return node.action;
    case "gate":
      return `${node.branches.length} branch${node.branches.length === 1 ? "" : "es"}${node.otherwise === undefined ? "" : " + otherwise"}`;
    case "merge":
      return `merge · ${node.strategy.kind}`;
    case "human":
      return `human · ${node.form.kind}`;
    case "subgraph":
      return `${node.template.scope}:${node.template.id}`;
  }
}

function replicateLabel(replicate: GraphReplicate): string {
  switch (replicate.over) {
    case "panel":
      return "×panel";
    case "lenses":
      return `×${replicate.lenses.length}`;
    case "samples":
      return `×${replicate.count}`;
    case "items":
      return `×≤${replicate.maxBranches}`;
    case "cross":
      return `×${replicate.axes.map((axis) => replicateLabel(axis).slice(1)).join("·")}`;
  }
}

function replicationBadge(node: GraphNodeSpec, planNode: GraphPlanNode | undefined) {
  const replicate = node.kind === "agent" || node.kind === "subgraph" ? node.replicate : undefined;
  if (!replicate) return undefined;
  if (planNode && (planNode.kind === "agent" || planNode.kind === "subgraph")) {
    const { min, max } = planNode.fanOut;
    if (replicate.over === "panel" || replicate.over === "cross" || replicate.over === "items") {
      return min === max ? `×${max}` : `×${min}–${max}`;
    }
  }
  return replicateLabel(replicate);
}

function enforcementFloor(
  node: GraphNodeSpec,
  planNode: GraphPlanNode | undefined,
): GraphEnforcementTier | undefined {
  if (node.kind !== "agent") return undefined;
  if (planNode?.kind === "agent") return planNode.minEnforcement;
  return node.minEnforcement;
}

function portView(
  direction: "in" | "out",
  port: { name: string; type: string; label?: string; required?: boolean },
  library: GraphTypeLibrary,
): GraphDesignerPortView {
  return {
    name: port.name,
    type: port.type,
    family: graphTypeFamily(port.type, library),
    ...(port.label ? { label: port.label } : {}),
    required: port.required !== false,
    handleId: `${direction}:${port.name}`,
  };
}

/** The type the producer of `source` declares, for an edge drawn before (or without) a plan. */
function sourceType(template: GraphTemplateV1, source: GraphEdgeSource): string | undefined {
  if (isGraphRunInputRef(source)) {
    return template.inputs.find((input) => input.name === source.input)?.type;
  }
  const node = template.nodes.find((candidate) => candidate.id === source.node);
  if (!node) return undefined;
  if (source.outlet !== undefined) {
    // An outlet forwards the node's input of that name.
    return node.inputs?.find((input) => input.name === source.port)?.type;
  }
  const outputs = "outputs" in node ? node.outputs : undefined;
  return outputs?.find((output) => output.name === source.port)?.type;
}

interface Endpoint {
  node: string;
  handle: string;
}

function sourceEndpoint(source: GraphEdgeSource): Endpoint {
  if (isGraphRunInputRef(source)) {
    return { node: GRAPH_INPUTS_NODE_ID, handle: `out:${source.input}` };
  }
  return source.outlet !== undefined
    ? { node: source.node, handle: `outlet:${source.outlet}` }
    : { node: source.node, handle: `out:${source.port}` };
}

export interface GraphCanvasModelInput {
  template: GraphTemplateV1;
  /**
   * The editable canvas (item 212): both I/O ends always shown, a `+` input
   * handle on every node that can take one, and loop members free to leave
   * their frame.
   */
  editable?: boolean;
  /** The compiled plan, when the template compiled without errors. */
  plan?: CompiledGraphPlan | null;
  diagnostics?: readonly GraphCompileDiagnostic[];
}

/** Projects a template (with its plan and diagnostics, when known) onto the canvas. */
export function buildGraphCanvasModel(input: GraphCanvasModelInput): GraphCanvasModel {
  const { template } = input;
  const plan = input.plan ?? null;
  const diagnostics = indexGraphDiagnostics(input.diagnostics ?? []);
  const library = graphTemplateTypeLibrary(template);
  const editable = input.editable === true;
  const layout = layoutGraphTemplate(template, { alwaysIo: editable });
  const planNodes = new Map((plan?.nodes ?? []).map((node) => [node.id, node]));
  const planEdges = new Map((plan?.edges ?? []).map((edge) => [edge.id, edge]));
  const counts = (map: Map<string, GraphCompileDiagnostic[]>, key: string) => {
    const list = map.get(key);
    return list ? graphDiagnosticCounts(list) : NO_GRAPH_DIAGNOSTICS;
  };

  const nodes: GraphCanvasNode[] = [];
  const parentOf = new Map<string, string>();
  for (const loop of template.loops ?? []) {
    const box = layout.loops.get(loop.id);
    if (!box) continue;
    const groupId = `loop:${loop.id}`;
    for (const member of loop.nodes) if (!parentOf.has(member)) parentOf.set(member, loop.id);
    const loopDiagnostics = counts(diagnostics.loops, loop.id);
    nodes.push({
      id: groupId,
      type: "graph-loop",
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      style: { width: box.width, height: box.height },
      focusable: false,
      zIndex: -1,
      data: {
        loopId: loop.id,
        label: loop.label?.trim() || loop.id,
        maxIterations: loop.maxIterations,
        diagnostics: loopDiagnostics,
      },
    });
  }

  const handles = new Map<string, Set<string>>();
  const addHandles = (id: string, list: Iterable<string>) => handles.set(id, new Set(list));

  for (const node of template.nodes) {
    const box = layout.boxes.get(node.id)!;
    const loopId = parentOf.get(node.id);
    const loopBox = loopId ? layout.loops.get(loopId) : undefined;
    const planNode = planNodes.get(node.id);
    const inputs = (node.inputs ?? []).map((port) => portView("in", port, library));
    const outputs =
      "outputs" in node ? (node.outputs ?? []).map((port) => portView("out", port, library)) : [];
    const outlets = (graphNodeOutlets(node) ?? []).map((name) => ({
      name,
      handleId: `outlet:${name}`,
    }));
    addHandles(node.id, [
      ...inputs.map((port) => port.handleId),
      ...outputs.map((port) => port.handleId),
      ...outlets.map((outlet) => outlet.handleId),
    ]);
    const nodeDiagnostics = counts(diagnostics.nodes, node.id);
    const title = graphNodeTitle(node);
    const detail = graphNodeDetail(node);
    const enforcement = enforcementFloor(node, planNode);
    const replication = replicationBadge(node, planNode);
    const sideEffect =
      node.kind === "system" && GRAPH_SYSTEM_ACTION_SPECS[node.action]?.sideEffect === true;
    const ariaLabel = [
      title,
      GRAPH_NODE_KIND_LABELS[node.kind].toLowerCase(),
      detail,
      replication ? `replicated ${replication}` : null,
      sideEffect ? "side effect" : null,
      nodeDiagnostics.errors > 0
        ? `${nodeDiagnostics.errors} error${nodeDiagnostics.errors === 1 ? "" : "s"}`
        : null,
      nodeDiagnostics.warnings > 0
        ? `${nodeDiagnostics.warnings} warning${nodeDiagnostics.warnings === 1 ? "" : "s"}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    nodes.push({
      id: node.id,
      type: "graph-node",
      position: loopBox ? { x: box.x - loopBox.x, y: box.y - loopBox.y } : { x: box.x, y: box.y },
      ...(loopId && loopBox
        ? { parentId: `loop:${loopId}`, ...(editable ? {} : { extent: "parent" as const }) }
        : {}),
      width: box.width,
      ariaRole: "button",
      ariaLabel,
      data: {
        nodeId: node.id,
        kind: node.kind,
        title,
        detail,
        ...(enforcement ? { enforcement } : {}),
        ...(replication ? { replication } : {}),
        ...(sideEffect ? { sideEffect } : {}),
        inputs,
        outputs,
        outlets,
        diagnostics: nodeDiagnostics,
        ariaLabel,
        ...(editable && node.kind !== "subgraph" ? { newInput: true } : {}),
      },
    });
    if (editable && node.kind !== "subgraph") handles.get(node.id)!.add("in:+");
  }

  const inputsBox = layout.boxes.get(GRAPH_INPUTS_NODE_ID);
  if (inputsBox) {
    const ports = template.inputs.map((port) => portView("out", port, library));
    addHandles(
      GRAPH_INPUTS_NODE_ID,
      ports.map((port) => port.handleId),
    );
    nodes.push({
      id: GRAPH_INPUTS_NODE_ID,
      type: "graph-io",
      position: { x: inputsBox.x, y: inputsBox.y },
      width: inputsBox.width,
      focusable: false,
      selectable: false,
      draggable: false,
      data: { direction: "inputs", ports },
    });
  }
  const outputsBox = layout.boxes.get(GRAPH_OUTPUTS_NODE_ID);
  if (outputsBox) {
    const ports = (template.outputs ?? []).map((port) => portView("in", port, library));
    addHandles(GRAPH_OUTPUTS_NODE_ID, [
      ...ports.map((port) => port.handleId),
      ...(editable ? ["in:+"] : []),
    ]);
    nodes.push({
      id: GRAPH_OUTPUTS_NODE_ID,
      type: "graph-io",
      position: { x: outputsBox.x, y: outputsBox.y },
      width: outputsBox.width,
      focusable: false,
      selectable: false,
      draggable: false,
      data: { direction: "outputs", ports, ...(editable ? { newPort: true } : {}) },
    });
  }

  const drawable = (endpoint: Endpoint) =>
    handles.get(endpoint.node)?.has(endpoint.handle) ?? false;
  const edges: GraphCanvasEdge[] = [];
  const undrawnEdges: string[] = [];
  for (const edge of template.edges) {
    const source = sourceEndpoint(edge.from);
    const target = { node: edge.to.node, handle: `in:${edge.to.port}` };
    if (!drawable(source) || !drawable(target)) {
      undrawnEdges.push(edge.id);
      continue;
    }
    const planEdge = planEdges.get(edge.id);
    const declared = sourceType(template, edge.from);
    const family = planEdge
      ? graphPlanValueTypeFamily(planEdge.deliveredType, library)
      : declared
        ? graphTypeFamily(declared, library)
        : "unknown";
    const typeLabel = planEdge?.deliveredType
      ? graphPlanValueTypeLabel(planEdge.deliveredType)
      : (declared ?? "unknown");
    const edgeDiagnostics = counts(diagnostics.edges, edge.id);
    const transforms = (edge.transform ?? []).map((transform) => transform.op);
    edges.push({
      id: edge.id,
      source: source.node,
      sourceHandle: source.handle,
      target: target.node,
      targetHandle: target.handle,
      ...(transforms.length > 0 || edge.zip
        ? {
            label: [...transforms, ...(edge.zip ? ["zip"] : [])].join(" → "),
          }
        : {}),
      ariaLabel: `Edge ${edge.id}: ${typeLabel}`,
      data: { kind: "edge", family, typeLabel, diagnostics: edgeDiagnostics, ref: edge.id },
    });
  }

  for (const loop of template.loops ?? []) {
    loop.carry.forEach((carry, index) => {
      const source = { node: carry.from.node, handle: `out:${carry.from.port}` };
      const target = { node: carry.to.node, handle: `in:${carry.to.port}` };
      if (!drawable(source) || !drawable(target)) return;
      const declared = sourceType(template, carry.from);
      edges.push({
        id: graphCarryEdgeId(loop.id, index),
        source: source.node,
        sourceHandle: source.handle,
        target: target.node,
        targetHandle: target.handle,
        label: "carry",
        ariaLabel: `Loop ${loop.id} carries ${carry.from.node}.${carry.from.port} to ${carry.to.node}.${carry.to.port}`,
        data: {
          kind: "carry",
          family: declared ? graphTypeFamily(declared, library) : "unknown",
          typeLabel: declared ?? "unknown",
          diagnostics: counts(diagnostics.loops, loop.id),
          ref: loop.id,
        },
      });
    });
  }

  for (const output of template.outputs ?? []) {
    const source = sourceEndpoint(output.from);
    const target = { node: GRAPH_OUTPUTS_NODE_ID, handle: `in:${output.name}` };
    if (!drawable(source) || !drawable(target)) continue;
    edges.push({
      id: graphOutputEdgeId(output.name),
      source: source.node,
      sourceHandle: source.handle,
      target: target.node,
      targetHandle: target.handle,
      ariaLabel: `Run output ${output.name}`,
      data: {
        kind: "output",
        family: graphTypeFamily(output.type, library),
        typeLabel: output.type,
        diagnostics: NO_GRAPH_DIAGNOSTICS,
        ref: output.name,
      },
    });
  }

  const known = new Set(template.nodes.map((node) => node.id));
  const order = plan
    ? [
        ...plan.order.filter((id) => known.has(id)),
        ...layout.order.filter((id) => !plan.order.includes(id)),
      ]
    : layout.order;
  return { nodes, edges, order, layout, undrawnEdges, diagnostics };
}
