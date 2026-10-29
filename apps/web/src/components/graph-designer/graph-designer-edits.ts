import type { GraphPlanAcknowledgementRef } from "@orkestrator/protocol/graphs/compile";
import { GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import type { GraphPredicate } from "@orkestrator/protocol/graphs/predicates";
import {
  GRAPH_TEMPLATE_FORMAT,
  GRAPH_TEMPLATE_FORMAT_VERSION,
  isGraphRunInputRef,
  type GraphAgentNode,
  type GraphEdgeSource,
  type GraphGateNode,
  type GraphHumanNode,
  type GraphInputPortSpec,
  type GraphLayoutPoint,
  type GraphLoopRegion,
  type GraphMergeNode,
  type GraphNodeSpec,
  type GraphSystemAction,
  type GraphSystemNode,
  type GraphTemplateRef,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import { layoutGraphTemplate } from "./graph-designer-layout";
import { graphSubgraphNode, graphSubgraphRoles } from "./graph-designer-subgraphs";
import { graphSystemDefaultPorts } from "./graph-designer-system-actions";

/**
 * Pure template edits for the editable designer (item 212). Each takes a
 * template and returns a new one (the input is never mutated), so the store
 * can keep the previous template as an undo step. Edits keep references
 * consistent: renaming or removing a node or port rewrites or drops the
 * edges, carries, run outputs, loop members, predicates and layout entries
 * that name it. Anything left inconsistent is the compiler's to report.
 */

const B = GRAPH_TEMPLATE_BOUNDS;

// ---------------------------------------------------------------- names

/** Text to a kebab-case id (`GRAPH_ID_PATTERN`), or `fallback`. */
export function graphIdFrom(text: string, fallback = "node"): string {
  const id = text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, B.maxIdChars - 4)
    .replace(/-+$/, "");
  return id || fallback;
}

/** `base`, or `base-2`, `base-3`, … whichever is not taken. */
export function uniqueGraphId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Text to a port or parameter key (`GRAPH_KEY_PATTERN`), or `fallback`. */
export function graphKeyFrom(text: string, fallback = "value"): string {
  const parts = text
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("")
    .replace(/^[^a-z]+/, "")
    .slice(0, B.maxKeyChars - 3);
  return key || fallback;
}

/** `base`, or `base2`, `base3`, … whichever is not taken. */
export function uniqueGraphKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------- template

/** The starting point of "New graph": no nodes yet, one environment, small limits. */
export function blankGraphTemplate(
  options: { id?: string; name?: string; description?: string } = {},
): GraphTemplateV1 {
  return {
    format: GRAPH_TEMPLATE_FORMAT,
    formatVersion: GRAPH_TEMPLATE_FORMAT_VERSION,
    id: options.id ?? "new-graph",
    revision: 0,
    name: options.name ?? "New graph",
    ...(options.description ? { description: options.description } : {}),
    parameters: [],
    roles: [],
    inputs: [],
    outputs: [],
    workspace: { kind: "environment" },
    nodes: [],
    edges: [],
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 4 },
    layout: {},
  };
}

export function graphNodeById(template: GraphTemplateV1, id: string): GraphNodeSpec | undefined {
  return template.nodes.find((node) => node.id === id);
}

function round(point: GraphLayoutPoint): GraphLayoutPoint {
  const clamp = (value: number) =>
    Math.max(-B.maxLayoutCoordinateAbs, Math.min(B.maxLayoutCoordinateAbs, Math.round(value)));
  return { x: clamp(point.x), y: clamp(point.y) };
}

/**
 * Every node's position, as the canvas shows it now. The canvas honours a
 * saved layout only when it places every node, so the first edit writes them
 * all; later edits keep it complete.
 */
export function materializeGraphLayout(
  template: GraphTemplateV1,
): Record<string, GraphLayoutPoint> {
  const layout = layoutGraphTemplate(template);
  const positions: Record<string, GraphLayoutPoint> = {};
  for (const node of template.nodes) {
    const box = layout.boxes.get(node.id);
    if (box) positions[node.id] = round(box);
  }
  return positions;
}

/** Lays every node out automatically (layers by edges, one band per loop) and keeps it. */
export function arrangeGraphLayout(template: GraphTemplateV1): GraphTemplateV1 {
  const { layout: _ignored, ...rest } = template;
  return { ...template, layout: materializeGraphLayout(rest) };
}

/** Moves nodes to absolute canvas positions; the rest keep theirs. */
export function moveGraphNodes(
  template: GraphTemplateV1,
  positions: Readonly<Record<string, GraphLayoutPoint>>,
): GraphTemplateV1 {
  const layout = materializeGraphLayout(template);
  for (const [id, point] of Object.entries(positions)) {
    if (graphNodeById(template, id)) layout[id] = round(point);
  }
  return { ...template, layout };
}

// ---------------------------------------------------------------- nodes

export type GraphPaletteItem =
  | { kind: "agent" }
  | { kind: "system"; action: GraphSystemAction }
  | { kind: "gate" }
  | { kind: "merge" }
  | { kind: "human" }
  /** A saved template as one node (item 402), already read so its ports are known. */
  | { kind: "subgraph"; ref: GraphTemplateRef; child: GraphTemplateV1 };

function freshAgent(id: string): GraphAgentNode {
  return {
    id,
    kind: "agent",
    role: id,
    capabilities: { profile: "reviewer" },
    workspaceAccess: "read",
    prompt: { template: "Describe what this step should do.\n" },
    inputs: [],
    outputs: [{ name: "result", type: "markdown@1" }],
  };
}

function freshNode(template: GraphTemplateV1, item: GraphPaletteItem, id: string): GraphNodeSpec {
  switch (item.kind) {
    case "agent":
      return freshAgent(id);
    case "system": {
      // The action's spec (207) says what it reads and produces.
      const ports = graphSystemDefaultPorts(
        item.action,
        new GraphTypeLibrary(template.types ?? []),
      );
      const node: GraphSystemNode = { id, kind: "system", action: item.action, ...ports };
      return node;
    }
    case "gate": {
      // Starts on `run.iteration`, which always resolves; the user writes the real condition.
      const node: GraphGateNode = {
        id,
        kind: "gate",
        inputs: [],
        branches: [{ to: "yes", when: { path: "run.iteration", op: "gte", value: 1 } }],
        otherwise: "no",
      };
      return node;
    }
    case "merge": {
      // D11: deterministic dedupe; the key is chosen when a list is connected.
      const node: GraphMergeNode = {
        id,
        kind: "merge",
        inputs: [],
        outputs: [],
        strategy: { kind: "dedupe", key: ["title"] },
      };
      return node;
    }
    case "human": {
      const node: GraphHumanNode = { id, kind: "human", form: { kind: "approve" }, inputs: [] };
      return node;
    }
    case "subgraph":
      return graphSubgraphNode(id, item.ref, item.child);
  }
}

function paletteBaseId(item: GraphPaletteItem): string {
  if (item.kind === "subgraph") return graphIdFrom(item.child.id, "subgraph");
  return item.kind === "system" ? item.action : item.kind;
}

/**
 * Adds a node from the palette at `position`. An agent node gets a role of
 * its own name (roles are the model slots chosen at launch), so it compiles
 * before the user picks or shares roles; a sub-graph node gets the child's
 * roles the template lacks.
 */
export function addGraphNode(
  template: GraphTemplateV1,
  item: GraphPaletteItem,
  position: GraphLayoutPoint,
  options: { id?: string; loopId?: string } = {},
): { template: GraphTemplateV1; nodeId: string } {
  const taken = new Set(template.nodes.map((node) => node.id));
  const id = options.id ?? uniqueGraphId(paletteBaseId(item), taken);
  const node = freshNode(template, item, id);
  let roles = template.roles;
  if (node.kind === "agent" && !roles.some((role) => role.key === node.role)) {
    roles = [...roles, { key: node.role, multiplicity: "one" }];
  }
  // A sub-graph binds each child role to the parent role of the same key.
  if (item.kind === "subgraph") roles = graphSubgraphRoles(roles, item.child);
  const layout = { ...materializeGraphLayout(template), [id]: round(position) };
  let next: GraphTemplateV1 = { ...template, roles, nodes: [...template.nodes, node], layout };
  if (options.loopId) next = addGraphNodeToLoop(next, id, options.loopId);
  return { template: next, nodeId: id };
}

/** Replaces one node; `recipe` returns the new node (or the same one for no change). */
export function updateGraphNode(
  template: GraphTemplateV1,
  nodeId: string,
  recipe: (node: GraphNodeSpec) => GraphNodeSpec,
): GraphTemplateV1 {
  let changed = false;
  const nodes = template.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const next = recipe(node);
    if (next !== node) changed = true;
    return next;
  });
  return changed ? { ...template, nodes } : template;
}

function sourceNamesNode(source: GraphEdgeSource, nodeId: string): boolean {
  return !isGraphRunInputRef(source) && source.node === nodeId;
}

/** Removes a node with everything that names it. Roles stay (another node may use them). */
export function removeGraphNode(template: GraphTemplateV1, nodeId: string): GraphTemplateV1 {
  const layout = { ...template.layout };
  delete layout[nodeId];
  const loops = (template.loops ?? [])
    .map((loop) => ({
      ...loop,
      nodes: loop.nodes.filter((member) => member !== nodeId),
      carry: loop.carry.filter((carry) => carry.from.node !== nodeId && carry.to.node !== nodeId),
    }))
    .filter((loop) => loop.nodes.length > 0);
  const nodes = template.nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => {
      let next = node;
      if (
        next.inputs?.some(
          (port) => port.firstIterationFrom && sourceNamesNode(port.firstIterationFrom, nodeId),
        )
      ) {
        next = {
          ...next,
          inputs: next.inputs!.map((port) => {
            if (!port.firstIterationFrom || !sourceNamesNode(port.firstIterationFrom, nodeId))
              return port;
            const { firstIterationFrom: _drop, ...rest } = port;
            return rest;
          }),
        } as GraphNodeSpec;
      }
      if (
        next.kind === "agent" &&
        next.session?.mode === "continue" &&
        next.session.from === nodeId
      ) {
        next = { ...next, session: { mode: "fresh" } };
      }
      return next;
    });
  const next: GraphTemplateV1 = {
    ...template,
    nodes,
    edges: template.edges.filter(
      (edge) => edge.to.node !== nodeId && !sourceNamesNode(edge.from, nodeId),
    ),
    outputs: (template.outputs ?? []).filter((output) => output.from.node !== nodeId),
    layout,
  };
  if (template.loops) next.loops = loops;
  return next;
}

/** Rewrites predicate paths; `rename` returns the new path (or the same). */
export function mapGraphPredicatePaths(
  predicate: GraphPredicate,
  rename: (path: string) => string,
): GraphPredicate {
  if ("all" in predicate)
    return { all: predicate.all.map((entry) => mapGraphPredicatePaths(entry, rename)) };
  if ("any" in predicate)
    return { any: predicate.any.map((entry) => mapGraphPredicatePaths(entry, rename)) };
  if ("not" in predicate) return { not: mapGraphPredicatePaths(predicate.not, rename) };
  const path = rename(predicate.path);
  return path === predicate.path ? predicate : { ...predicate, path };
}

/** `old` or `old.rest` becomes `next` / `next.rest`. */
function renameRoot(path: string, old: string, next: string): string {
  if (path === old) return next;
  return path.startsWith(`${old}.`) ? `${next}${path.slice(old.length)}` : path;
}

function renameSource(source: GraphEdgeSource, from: string, to: string): GraphEdgeSource {
  return !isGraphRunInputRef(source) && source.node === from ? { ...source, node: to } : source;
}

/**
 * Renames a node and every reference to it. `to` must be a free, valid id.
 * An agent node whose role is still the one it was created with (named after
 * it, used by no other node) takes the new name for its role too.
 */
export function renameGraphNode(
  original: GraphTemplateV1,
  from: string,
  to: string,
): GraphTemplateV1 {
  const renamed = graphNodeById(original, from);
  if (from === to || !renamed) return original;
  let template = original;
  if (
    renamed.kind === "agent" &&
    renamed.role === from &&
    !template.roles.some((role) => role.key === to) &&
    !template.nodes.some((node) => node.id !== from && node.kind === "agent" && node.role === from)
  ) {
    template = {
      ...template,
      roles: template.roles.map((role) => (role.key === from ? { ...role, key: to } : role)),
      nodes: template.nodes.map((node) =>
        node.id === from && node.kind === "agent" ? { ...node, role: to } : node,
      ),
    };
  }
  const layout: Record<string, GraphLayoutPoint> = {};
  for (const [id, point] of Object.entries(template.layout ?? {}))
    layout[id === from ? to : id] = point;
  const nodes = template.nodes.map((node) => {
    let next: GraphNodeSpec = node.id === from ? { ...node, id: to } : node;
    if (next.inputs?.some((port) => port.firstIterationFrom)) {
      next = {
        ...next,
        inputs: next.inputs!.map((port) =>
          port.firstIterationFrom
            ? { ...port, firstIterationFrom: renameSource(port.firstIterationFrom, from, to) }
            : port,
        ),
      } as GraphNodeSpec;
    }
    if (next.kind === "agent" && next.session?.mode === "continue" && next.session.from === from) {
      next = { ...next, session: { mode: "continue", from: to } };
    }
    return next;
  });
  const next: GraphTemplateV1 = {
    ...template,
    nodes,
    edges: template.edges.map((edge) => ({
      ...edge,
      from: renameSource(edge.from, from, to),
      to: edge.to.node === from ? { ...edge.to, node: to } : edge.to,
    })),
    outputs: (template.outputs ?? []).map((output) =>
      output.from.node === from ? { ...output, from: { ...output.from, node: to } } : output,
    ),
    ...(template.layout ? { layout } : {}),
  };
  if (template.loops) {
    next.loops = template.loops.map((loop) => ({
      ...loop,
      nodes: loop.nodes.map((member) => (member === from ? to : member)),
      until: mapGraphPredicatePaths(loop.until, (path) => renameRoot(path, from, to)),
      carry: loop.carry.map((carry) => ({
        from: carry.from.node === from ? { ...carry.from, node: to } : carry.from,
        to: carry.to.node === from ? { ...carry.to, node: to } : carry.to,
      })),
    }));
  }
  return next;
}

// ---------------------------------------------------------------- ports

function outputsOf(node: GraphNodeSpec) {
  return "outputs" in node ? (node.outputs ?? []) : [];
}

/** Renames an input port and the edges, carries, outlets and predicates that name it. */
export function renameGraphInputPort(
  template: GraphTemplateV1,
  nodeId: string,
  from: string,
  to: string,
): GraphTemplateV1 {
  if (from === to) return template;
  const nodes = template.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const inputs = (node.inputs ?? []).map((port) =>
      port.name === from ? { ...port, name: to } : port,
    );
    let next = { ...node, inputs } as GraphNodeSpec;
    if (next.when)
      next = {
        ...next,
        when: mapGraphPredicatePaths(next.when, (path) => renameRoot(path, from, to)),
      };
    if (next.kind === "gate") {
      next = {
        ...next,
        branches: next.branches.map((branch) => ({
          ...branch,
          when: mapGraphPredicatePaths(branch.when, (path) => renameRoot(path, from, to)),
        })),
      };
    }
    if (next.kind === "human" && next.form.kind === "edit" && next.form.edit === from) {
      next = { ...next, form: { ...next.form, edit: to } };
    }
    if (
      next.kind === "agent" &&
      next.replicate?.over === "items" &&
      next.replicate.input === from
    ) {
      next = { ...next, replicate: { ...next.replicate, input: to } };
    }
    return next;
  });
  // An outlet forwards the node's inputs by name.
  const renameOutletSource = (source: GraphEdgeSource): GraphEdgeSource =>
    !isGraphRunInputRef(source) &&
    source.node === nodeId &&
    source.outlet !== undefined &&
    source.port === from
      ? { ...source, port: to }
      : source;
  const next: GraphTemplateV1 = {
    ...template,
    nodes,
    edges: template.edges.map((edge) => ({
      ...edge,
      from: renameOutletSource(edge.from),
      to: edge.to.node === nodeId && edge.to.port === from ? { ...edge.to, port: to } : edge.to,
    })),
    outputs: (template.outputs ?? []).map((output) => ({
      ...output,
      from: renameOutletSource(output.from) as typeof output.from,
    })),
  };
  if (template.loops) {
    next.loops = template.loops.map((loop) => ({
      ...loop,
      carry: loop.carry.map((carry) =>
        carry.to.node === nodeId && carry.to.port === from
          ? { ...carry, to: { ...carry.to, port: to } }
          : carry,
      ),
    }));
  }
  return next;
}

/** Renames an output port and the edges, carries, run outputs and loop conditions that read it. */
export function renameGraphOutputPort(
  template: GraphTemplateV1,
  nodeId: string,
  from: string,
  to: string,
): GraphTemplateV1 {
  if (from === to) return template;
  const nodes = template.nodes.map((node) =>
    node.id === nodeId && "outputs" in node
      ? ({
          ...node,
          outputs: outputsOf(node).map((port) =>
            port.name === from ? { ...port, name: to } : port,
          ),
        } as GraphNodeSpec)
      : node,
  );
  const renames = (source: GraphEdgeSource) =>
    !isGraphRunInputRef(source) &&
    source.node === nodeId &&
    source.outlet === undefined &&
    source.port === from;
  const next: GraphTemplateV1 = {
    ...template,
    nodes,
    edges: template.edges.map((edge) =>
      renames(edge.from) ? { ...edge, from: { ...edge.from, port: to } } : edge,
    ),
    outputs: (template.outputs ?? []).map((output) =>
      renames(output.from) ? { ...output, from: { ...output.from, port: to } } : output,
    ),
  };
  if (template.loops) {
    next.loops = template.loops.map((loop) => ({
      ...loop,
      until: mapGraphPredicatePaths(loop.until, (path) =>
        renameRoot(path, `${nodeId}.${from}`, `${nodeId}.${to}`),
      ),
      carry: loop.carry.map((carry) =>
        renames(carry.from) ? { ...carry, from: { ...carry.from, port: to } } : carry,
      ),
    }));
  }
  return next;
}

/** Removes an input port and every edge or carry into it (and outlet edges that forward it). */
export function removeGraphInputPort(
  template: GraphTemplateV1,
  nodeId: string,
  name: string,
): GraphTemplateV1 {
  const forwards = (source: GraphEdgeSource) =>
    !isGraphRunInputRef(source) &&
    source.node === nodeId &&
    source.outlet !== undefined &&
    source.port === name;
  const next: GraphTemplateV1 = {
    ...updateGraphNode(
      template,
      nodeId,
      (node) =>
        ({
          ...node,
          inputs: (node.inputs ?? []).filter((port) => port.name !== name),
        }) as GraphNodeSpec,
    ),
  };
  next.edges = template.edges.filter(
    (edge) => !(edge.to.node === nodeId && edge.to.port === name) && !forwards(edge.from),
  );
  next.outputs = (template.outputs ?? []).filter((output) => !forwards(output.from));
  if (template.loops) {
    next.loops = template.loops.map((loop) => ({
      ...loop,
      carry: loop.carry.filter((carry) => !(carry.to.node === nodeId && carry.to.port === name)),
    }));
  }
  return next;
}

/** Removes an output port and every edge, carry or run output reading it. */
export function removeGraphOutputPort(
  template: GraphTemplateV1,
  nodeId: string,
  name: string,
): GraphTemplateV1 {
  const reads = (source: GraphEdgeSource) =>
    !isGraphRunInputRef(source) &&
    source.node === nodeId &&
    source.outlet === undefined &&
    source.port === name;
  const next: GraphTemplateV1 = updateGraphNode(template, nodeId, (node) =>
    "outputs" in node
      ? ({
          ...node,
          outputs: outputsOf(node).filter((port) => port.name !== name),
        } as GraphNodeSpec)
      : node,
  );
  const result: GraphTemplateV1 = {
    ...next,
    edges: template.edges.filter((edge) => !reads(edge.from)),
    outputs: (template.outputs ?? []).filter((output) => !reads(output.from)),
  };
  if (template.loops) {
    result.loops = template.loops.map((loop) => ({
      ...loop,
      carry: loop.carry.filter((carry) => !reads(carry.from)),
    }));
  }
  return result;
}

/** Adds an input port to a node, under a free name derived from `name`. */
export function addGraphInputPort(
  template: GraphTemplateV1,
  nodeId: string,
  port: GraphInputPortSpec,
): { template: GraphTemplateV1; name: string } {
  const node = graphNodeById(template, nodeId);
  if (!node) return { template, name: port.name };
  const name = uniqueGraphKey(
    port.name,
    (node.inputs ?? []).map((entry) => entry.name),
  );
  return {
    template: updateGraphNode(
      template,
      nodeId,
      (current) =>
        ({ ...current, inputs: [...(current.inputs ?? []), { ...port, name }] }) as GraphNodeSpec,
    ),
    name,
  };
}

// ---------------------------------------------------------------- run inputs and outputs

/** Renames a run input and the edges and loop entries that read it. */
export function renameGraphRunInput(
  template: GraphTemplateV1,
  from: string,
  to: string,
): GraphTemplateV1 {
  if (from === to) return template;
  const rename = (source: GraphEdgeSource): GraphEdgeSource =>
    isGraphRunInputRef(source) && source.input === from ? { input: to } : source;
  return {
    ...template,
    inputs: template.inputs.map((input) => (input.name === from ? { ...input, name: to } : input)),
    edges: template.edges.map((edge) => ({ ...edge, from: rename(edge.from) })),
    nodes: template.nodes.map((node) =>
      node.inputs?.some((port) => port.firstIterationFrom)
        ? ({
            ...node,
            inputs: node.inputs.map((port) =>
              port.firstIterationFrom
                ? { ...port, firstIterationFrom: rename(port.firstIterationFrom) }
                : port,
            ),
          } as GraphNodeSpec)
        : node,
    ),
  };
}

/** Removes a run input and the edges from it. */
export function removeGraphRunInput(template: GraphTemplateV1, name: string): GraphTemplateV1 {
  const reads = (source: GraphEdgeSource) => isGraphRunInputRef(source) && source.input === name;
  return {
    ...template,
    inputs: template.inputs.filter((input) => input.name !== name),
    edges: template.edges.filter((edge) => !reads(edge.from)),
    nodes: template.nodes.map((node) =>
      node.inputs?.some((port) => port.firstIterationFrom && reads(port.firstIterationFrom))
        ? ({
            ...node,
            inputs: node.inputs.map((port) => {
              if (!port.firstIterationFrom || !reads(port.firstIterationFrom)) return port;
              const { firstIterationFrom: _drop, ...rest } = port;
              return rest;
            }),
          } as GraphNodeSpec)
        : node,
    ),
  };
}

// ---------------------------------------------------------------- edges

export function removeGraphEdge(template: GraphTemplateV1, edgeId: string): GraphTemplateV1 {
  return { ...template, edges: template.edges.filter((edge) => edge.id !== edgeId) };
}

export function removeGraphCarry(
  template: GraphTemplateV1,
  loopId: string,
  index: number,
): GraphTemplateV1 {
  return updateGraphLoop(template, loopId, (loop) => ({
    ...loop,
    carry: loop.carry.filter((_, position) => position !== index),
  }));
}

export function removeGraphRunOutput(template: GraphTemplateV1, name: string): GraphTemplateV1 {
  return {
    ...template,
    outputs: (template.outputs ?? []).filter((output) => output.name !== name),
  };
}

// ---------------------------------------------------------------- loops

export function graphLoopOf(
  template: GraphTemplateV1,
  nodeId: string,
): GraphLoopRegion | undefined {
  return template.loops?.find((loop) => loop.nodes.includes(nodeId));
}

export function updateGraphLoop(
  template: GraphTemplateV1,
  loopId: string,
  recipe: (loop: GraphLoopRegion) => GraphLoopRegion,
): GraphTemplateV1 {
  if (!template.loops?.some((loop) => loop.id === loopId)) return template;
  return {
    ...template,
    loops: template.loops.map((loop) => (loop.id === loopId ? recipe(loop) : loop)),
  };
}

/**
 * Removes a node from its loop, with the carries that touch it. A loop left
 * without members is removed: a region needs at least one node.
 */
export function removeGraphNodeFromLoop(
  template: GraphTemplateV1,
  nodeId: string,
): GraphTemplateV1 {
  if (!graphLoopOf(template, nodeId)) return template;
  return {
    ...template,
    loops: (template.loops ?? [])
      .map((loop) =>
        loop.nodes.includes(nodeId)
          ? {
              ...loop,
              nodes: loop.nodes.filter((member) => member !== nodeId),
              carry: loop.carry.filter(
                (carry) => carry.from.node !== nodeId && carry.to.node !== nodeId,
              ),
            }
          : loop,
      )
      .filter((loop) => loop.nodes.length > 0),
  };
}

/** Moves a node into a loop region (out of any other: regions do not nest in version 1). */
export function addGraphNodeToLoop(
  template: GraphTemplateV1,
  nodeId: string,
  loopId: string,
): GraphTemplateV1 {
  if (!graphNodeById(template, nodeId)) return template;
  const current = graphLoopOf(template, nodeId);
  if (current?.id === loopId) return template;
  const without = current ? removeGraphNodeFromLoop(template, nodeId) : template;
  return updateGraphLoop(without, loopId, (loop) => ({ ...loop, nodes: [...loop.nodes, nodeId] }));
}

/**
 * Wraps nodes in a new loop region. It starts bounded at three iterations
 * (the Build Pipeline's default) and runs until the third: the user replaces
 * `until` with the real exit condition.
 */
export function createGraphLoop(
  template: GraphTemplateV1,
  nodeIds: readonly string[],
): { template: GraphTemplateV1; loopId: string } {
  const loopId = uniqueGraphId(
    "loop",
    (template.loops ?? []).map((loop) => loop.id),
  );
  let next: GraphTemplateV1 = template;
  for (const id of nodeIds) next = removeGraphNodeFromLoop(next, id);
  const loop: GraphLoopRegion = {
    id: loopId,
    nodes: nodeIds.filter((id) => graphNodeById(template, id)),
    until: { path: "run.iteration", op: "gte", value: 3 },
    maxIterations: 3,
    carry: [],
  };
  return { template: { ...next, loops: [...(next.loops ?? []), loop] }, loopId };
}

/** Removes a loop region; its members stay, outside any loop. */
export function removeGraphLoop(template: GraphTemplateV1, loopId: string): GraphTemplateV1 {
  const loops = (template.loops ?? []).filter((loop) => loop.id !== loopId);
  return { ...template, loops };
}

// ---------------------------------------------------------------- acknowledgements

/**
 * Records that the user accepted a warning (§5.13 taint, D4 lowered floor),
 * keyed by the compiler's digest: a change that alters the warning needs a
 * new acknowledgement.
 */
export function acknowledgeGraphWarning(
  template: GraphTemplateV1,
  ref: Pick<GraphPlanAcknowledgementRef, "kind" | "digest" | "code">,
  at: Date = new Date(),
  note?: string,
): GraphTemplateV1 {
  const existing = template.acknowledgements ?? [];
  if (existing.some((entry) => entry.kind === ref.kind && entry.digest === ref.digest))
    return template;
  return {
    ...template,
    acknowledgements: [
      ...existing,
      {
        kind: ref.kind,
        digest: ref.digest,
        acknowledgedAt: `${at.toISOString().slice(0, 19)}Z`,
        code: ref.code,
        ...(note ? { note } : {}),
      },
    ].slice(-B.maxAcknowledgements),
  };
}

/** Drops acknowledgements whose warning no longer exists (`acknowledgement-stale`). */
export function removeGraphAcknowledgements(
  template: GraphTemplateV1,
  indices: readonly number[],
): GraphTemplateV1 {
  const drop = new Set(indices);
  const kept = (template.acknowledgements ?? []).filter((_, index) => !drop.has(index));
  const next = { ...template };
  if (kept.length > 0) next.acknowledgements = kept;
  else delete next.acknowledgements;
  return next;
}
