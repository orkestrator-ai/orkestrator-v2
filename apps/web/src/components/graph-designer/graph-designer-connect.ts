import { graphSchemaAtPath, graphSchemaNonNull } from "@orkestrator/protocol/graphs/schema-subset";
import {
  graphNodeOutputSpecs,
  isGraphRunInputRef,
  type GraphEdgeSource,
  type GraphLayoutPoint,
  type GraphNodeSpec,
  type GraphPortRef,
  type GraphPortTarget,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import { graphTypeAssignability } from "@orkestrator/protocol/graphs/type-assignability";
import type { GraphTypeLibrary, GraphValueType } from "@orkestrator/protocol/graphs/types";
import {
  addGraphNodeToLoop,
  graphIdFrom,
  graphLoopOf,
  graphNodeById,
  materializeGraphLayout,
  uniqueGraphId,
  uniqueGraphKey,
  updateGraphLoop,
  updateGraphNode,
} from "./graph-designer-edits";
import { GRAPH_INPUTS_NODE_ID, GRAPH_OUTPUTS_NODE_ID } from "./graph-designer-layout";

/**
 * Drawing edges on the editable canvas (item 212, report §5.10). Given the
 * handle a drag starts from and a handle it could end on, decide whether the
 * connection is allowed and what it becomes:
 *
 * - **edge**: assignable types, one → one or many → list (fan-in);
 * - **zip**: replicated → replicated over the same branches, branch k to k;
 * - **carry**: an edge that would close a cycle inside one loop region
 *   becomes that loop's carry (previous iteration → next);
 * - **fan-in merge** (D11): a replicated producer into a single-value port
 *   of a non-merge node inserts a deterministic `dedupe` merge between them;
 *   when the element type declares no items to dedupe, the port becomes a
 *   `list<…>` that collects the branches instead;
 * - **new input** / **run output**: the `+` handles add a port of the
 *   delivered type.
 *
 * One value into a list port is refused: one → many is `replicate`, not an
 * edge. The canvas dims every handle this refuses while a drag is in
 * progress, and refuses the drop; the compiler stays the authority.
 */

/** The `+` handle on a node's inputs (and on the run outputs). */
export const GRAPH_NEW_PORT_HANDLE = "in:+";

export interface GraphConnectEnd {
  node: string;
  handle: string;
}

export type GraphConnectionPlan =
  | {
      kind: "edge";
      from: GraphEdgeSource;
      to: GraphPortTarget;
      zip?: boolean;
      fanIn?: boolean;
    }
  | { kind: "carry"; loopId: string; from: GraphPortRef; to: GraphPortTarget }
  | {
      kind: "fan-in-merge";
      from: GraphPortRef;
      to: GraphPortTarget;
      /** The element type, `name@major`. */
      element: string;
      key: string[];
    }
  | { kind: "fan-in-list"; from: GraphPortRef; to: GraphPortTarget; element: string }
  | { kind: "new-input"; from: GraphEdgeSource; node: string; name: string; type: string }
  | { kind: "run-output"; from: GraphPortRef; name: string; type: string; existing: boolean };

export type GraphConnectionVerdict =
  { ok: true; plan: GraphConnectionPlan; summary: string } | { ok: false; reason: string };

// ---------------------------------------------------------------- facts

function isReplicated(node: GraphNodeSpec | undefined): boolean {
  return Boolean(node && (node.kind === "agent" || node.kind === "subgraph") && node.replicate);
}

/** Branch signature for zip; null when zip cannot apply (items, or not replicated). */
export function graphReplicateSignature(node: GraphNodeSpec | undefined): string | null {
  if (!node || (node.kind !== "agent" && node.kind !== "subgraph") || !node.replicate) return null;
  const axes = node.replicate.over === "cross" ? node.replicate.axes : [node.replicate];
  const parts: string[] = [];
  for (const axis of axes) {
    switch (axis.over) {
      case "panel":
        parts.push(`panel:${axis.role}`);
        break;
      case "lenses":
        parts.push(`lenses:${axis.lenses.map((lens) => lens.key).join(",")}`);
        break;
      case "samples":
        parts.push(`samples:${axis.count}`);
        break;
      case "items":
        return null;
    }
  }
  return parts.join("×");
}

function listOf(ref: string): string {
  return `list<${ref}>`;
}

function stripList(ref: string): string | null {
  return ref.startsWith("list<") && ref.endsWith(">") ? ref.slice(5, -1) : null;
}

function resolve(library: GraphTypeLibrary, ref: string): GraphValueType | null {
  const result = library.resolve(ref);
  return result.ok ? result.type : null;
}

function outputsOf(node: GraphNodeSpec) {
  return graphNodeOutputSpecs(node);
}

/** Does `to` reach `from` along edges (so `from → to` would close a cycle)? */
function reaches(template: GraphTemplateV1, start: string, goal: string): boolean {
  const next = new Map<string, string[]>();
  for (const edge of template.edges) {
    if (isGraphRunInputRef(edge.from)) continue;
    const list = next.get(edge.from.node) ?? [];
    list.push(edge.to.node);
    next.set(edge.from.node, list);
  }
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === goal) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

/** Fields a dedupe merge folds on: file/line/title when the items have them (as findings do). */
export function defaultGraphDedupeKey(element: GraphValueType | null): string[] {
  if (!element || element.kind !== "named" || !element.definition.items) return ["id"];
  const field = graphSchemaAtPath(element.definition.schema, element.definition.items.path);
  const items = field ? graphSchemaNonNull(field.schema).schema.items : undefined;
  const properties =
    items && typeof items === "object" && !Array.isArray(items)
      ? ((items as { properties?: Record<string, { type?: unknown }> }).properties ?? {})
      : {};
  const names = Object.keys(properties);
  const preferred = ["file", "line", "title"].filter((name) => names.includes(name));
  if (preferred.length > 0) return preferred;
  if (names.includes("id")) return ["id"];
  const text = names.find((name) => properties[name]?.type === "string");
  return [text ?? names[0] ?? "id"];
}

interface SourceFacts {
  /** The edge source, without `port` for an outlet (chosen per target). */
  source: GraphEdgeSource | { node: string; outlet: string };
  label: string;
  /** The type delivered when not zipped (lifted to a list for a replicated node). */
  type: string | null;
  /** The single (per-branch) type of a replicated node's output. */
  element: string | null;
  replicated: boolean;
  nodeId: string | null;
}

function sourceFacts(template: GraphTemplateV1, end: GraphConnectEnd): SourceFacts | string {
  if (end.node === GRAPH_INPUTS_NODE_ID) {
    const name = end.handle.startsWith("out:") ? end.handle.slice(4) : "";
    const input = template.inputs.find((entry) => entry.name === name);
    if (!input) return "That run input no longer exists";
    return {
      source: { input: name },
      label: `run input ${name}`,
      type: input.type,
      element: null,
      replicated: false,
      nodeId: null,
    };
  }
  const node = graphNodeById(template, end.node);
  if (!node) return "That node no longer exists";
  if (end.handle.startsWith("outlet:")) {
    return {
      source: { node: node.id, outlet: end.handle.slice(7) },
      label: `${node.id} → ${end.handle.slice(7)}`,
      type: null,
      element: null,
      replicated: false,
      nodeId: node.id,
    };
  }
  if (!end.handle.startsWith("out:")) return "Connections start at an output or an outlet";
  const name = end.handle.slice(4);
  const port = outputsOf(node).find((entry) => entry.name === name);
  if (!port) return "That output no longer exists";
  const replicated = isReplicated(node);
  return {
    source: { node: node.id, port: name },
    label: `${node.id}.${name}`,
    type: replicated ? listOf(port.type) : port.type,
    element: replicated ? port.type : null,
    replicated,
    nodeId: node.id,
  };
}

function fits(
  library: GraphTypeLibrary,
  from: string,
  to: string,
): { ok: boolean; message?: string } {
  const source = resolve(library, from);
  const target = resolve(library, to);
  if (!source) return { ok: false, message: `${from} does not resolve` };
  if (!target) return { ok: false, message: `${to} does not resolve` };
  const fit = graphTypeAssignability(source, target);
  return fit.ok ? { ok: true } : { ok: false, message: fit.message };
}

/** An outlet forwards one of the node's inputs: the one that fits `targetType` (same name first). */
function outletPort(
  template: GraphTemplateV1,
  library: GraphTypeLibrary,
  nodeId: string,
  targetName: string | null,
  targetType: string | null,
): { port: string; type: string } | string {
  const node = graphNodeById(template, nodeId);
  const inputs = node?.inputs ?? [];
  if (inputs.length === 0) return `${nodeId} has no inputs for the outlet to forward`;
  if (targetType === null) {
    if (inputs.length === 1) return { port: inputs[0]!.name, type: inputs[0]!.type };
    return `The outlet forwards one of ${inputs.length} inputs; connect it to a typed port`;
  }
  const candidates = inputs.filter((port) => fits(library, port.type, targetType).ok);
  const chosen = candidates.find((port) => port.name === targetName) ?? candidates[0];
  if (!chosen) return `None of ${nodeId}'s inputs fits ${targetType}`;
  return { port: chosen.name, type: chosen.type };
}

function sameSource(a: GraphEdgeSource, b: GraphEdgeSource): boolean {
  if (isGraphRunInputRef(a) || isGraphRunInputRef(b)) {
    return isGraphRunInputRef(a) && isGraphRunInputRef(b) && a.input === b.input;
  }
  return a.node === b.node && a.port === b.port && a.outlet === b.outlet;
}

// ---------------------------------------------------------------- verdict

/**
 * Whether `source` may connect to `target`, and what the connection becomes.
 * The ends may come in either order (a drag can start at an input).
 */
export function graphConnectionVerdict(
  template: GraphTemplateV1,
  library: GraphTypeLibrary,
  first: GraphConnectEnd,
  second: GraphConnectEnd,
): GraphConnectionVerdict {
  const isSource = (end: GraphConnectEnd) =>
    end.handle.startsWith("out:") || end.handle.startsWith("outlet:");
  const [sourceEnd, targetEnd] = isSource(first) ? [first, second] : [second, first];
  if (!isSource(sourceEnd) || isSource(targetEnd)) {
    return { ok: false, reason: "Connect an output to an input" };
  }
  const facts = sourceFacts(template, sourceEnd);
  if (typeof facts === "string") return { ok: false, reason: facts };

  // Run outputs.
  if (targetEnd.node === GRAPH_OUTPUTS_NODE_ID) {
    if (facts.nodeId === null)
      return { ok: false, reason: "A run output comes from a node, not a run input" };
    const existingName =
      targetEnd.handle === GRAPH_NEW_PORT_HANDLE ? null : targetEnd.handle.slice(3);
    const existing = existingName
      ? template.outputs?.find((output) => output.name === existingName)
      : undefined;
    if (existingName && !existing) return { ok: false, reason: "That run output no longer exists" };
    let from: GraphPortRef;
    let type: string;
    if ("outlet" in facts.source && !("port" in facts.source)) {
      const chosen = outletPort(
        template,
        library,
        facts.source.node,
        existingName,
        existing?.type ?? null,
      );
      if (typeof chosen === "string") return { ok: false, reason: chosen };
      from = { node: facts.source.node, outlet: facts.source.outlet, port: chosen.port };
      type = chosen.type;
    } else {
      from = facts.source as GraphPortRef;
      type = facts.type!;
    }
    if (existing) {
      const fit = fits(library, type, existing.type);
      if (!fit.ok) return { ok: false, reason: fit.message! };
      return {
        ok: true,
        plan: {
          kind: "run-output",
          from,
          name: existing.name,
          type: existing.type,
          existing: true,
        },
        summary: `Run output ${existing.name} comes from ${facts.label}`,
      };
    }
    const name = uniqueGraphKey(
      from.port,
      (template.outputs ?? []).map((output) => output.name),
    );
    return {
      ok: true,
      plan: { kind: "run-output", from, name, type, existing: false },
      summary: `New run output ${name} from ${facts.label}`,
    };
  }

  const target = graphNodeById(template, targetEnd.node);
  if (!target) return { ok: false, reason: "That node no longer exists" };
  if (target.kind === "subgraph" && targetEnd.handle === GRAPH_NEW_PORT_HANDLE) {
    // Its ports are the child template's run inputs (item 402).
    return {
      ok: false,
      reason: "A sub-graph's inputs come from its template; connect to one of them",
    };
  }

  // The `+` handle: a new input port of the delivered type.
  if (targetEnd.handle === GRAPH_NEW_PORT_HANDLE) {
    let from: GraphEdgeSource;
    let type: string;
    let base: string;
    if ("outlet" in facts.source && !("port" in facts.source)) {
      const chosen = outletPort(template, library, facts.source.node, null, null);
      if (typeof chosen === "string") return { ok: false, reason: chosen };
      from = { node: facts.source.node, outlet: facts.source.outlet, port: chosen.port };
      type = chosen.type;
      base = chosen.port;
    } else {
      from = facts.source as GraphEdgeSource;
      type = facts.type!;
      base = isGraphRunInputRef(from) ? from.input : from.port;
    }
    if (facts.nodeId === target.id)
      return { ok: false, reason: "A node cannot feed itself outside a loop" };
    if (facts.nodeId !== null && reaches(template, target.id, facts.nodeId)) {
      return {
        ok: false,
        reason: `${target.id} already leads to ${facts.nodeId}; that would close a cycle`,
      };
    }
    const name = uniqueGraphKey(
      base,
      (target.inputs ?? []).map((port) => port.name),
    );
    return {
      ok: true,
      plan: { kind: "new-input", from, node: target.id, name, type },
      summary: `New input ${target.id}.${name}: ${type}`,
    };
  }

  if (!targetEnd.handle.startsWith("in:")) return { ok: false, reason: "Connect to an input" };
  const portName = targetEnd.handle.slice(3);
  const port = target.inputs?.find((entry) => entry.name === portName);
  if (!port) return { ok: false, reason: "That input no longer exists" };
  const to: GraphPortTarget = { node: target.id, port: port.name };

  // Resolve an outlet against this port.
  let from: GraphEdgeSource;
  let delivered: string;
  if ("outlet" in facts.source && !("port" in facts.source)) {
    const chosen = outletPort(template, library, facts.source.node, port.name, port.type);
    if (typeof chosen === "string") return { ok: false, reason: chosen };
    from = { node: facts.source.node, outlet: facts.source.outlet, port: chosen.port };
    delivered = chosen.type;
  } else {
    from = facts.source as GraphEdgeSource;
    delivered = facts.type!;
  }

  if (
    template.edges.some(
      (edge) => edge.to.node === to.node && edge.to.port === to.port && sameSource(edge.from, from),
    )
  ) {
    return { ok: false, reason: "Already connected" };
  }

  // A cycle is a carry when both ends are in one loop; otherwise refused.
  const sourceNodeId = isGraphRunInputRef(from) ? null : from.node;
  if (
    sourceNodeId !== null &&
    (sourceNodeId === target.id || reaches(template, target.id, sourceNodeId))
  ) {
    const loop = graphLoopOf(template, sourceNodeId);
    if (
      !loop ||
      !loop.nodes.includes(target.id) ||
      isGraphRunInputRef(from) ||
      from.outlet !== undefined
    ) {
      return {
        ok: false,
        reason: `That would close a cycle outside a loop region; put ${sourceNodeId} and ${target.id} in one loop first`,
      };
    }
    const fit = fits(library, delivered, port.type);
    if (!fit.ok) return { ok: false, reason: fit.message! };
    return {
      ok: true,
      plan: { kind: "carry", loopId: loop.id, from: from as GraphPortRef, to },
      summary: `Loop ${loop.id} carries ${facts.label} to the next iteration's ${target.id}.${port.name}`,
    };
  }

  const direct = fits(library, delivered, port.type);
  if (direct.ok) {
    return {
      ok: true,
      plan: { kind: "edge", from, to, ...(facts.replicated ? { fanIn: true } : {}) },
      summary: facts.replicated
        ? `${facts.label} fans in to ${target.id}.${port.name}`
        : `${facts.label} → ${target.id}.${port.name}`,
    };
  }

  if (facts.replicated && facts.element && stripList(port.type) === null) {
    const element = facts.element;
    const single = fits(library, element, port.type);
    if (single.ok) {
      // Replicated the same way: branch k feeds branch k.
      const signature = graphReplicateSignature(graphNodeById(template, facts.nodeId!));
      if (signature !== null && signature === graphReplicateSignature(target)) {
        return {
          ok: true,
          plan: { kind: "edge", from, to, zip: true },
          summary: `${facts.label} zips into ${target.id}.${port.name} (branch k feeds branch k)`,
        };
      }
      if (target.kind === "merge") {
        return {
          ok: true,
          plan: { kind: "fan-in-list", from: from as GraphPortRef, to, element },
          summary: `${target.id}.${port.name} becomes ${listOf(element)} to collect the branches`,
        };
      }
      const elementType = resolve(library, element);
      const hasItems = elementType?.kind === "named" && Boolean(elementType.definition.items);
      if (hasItems) {
        return {
          ok: true,
          plan: {
            kind: "fan-in-merge",
            from: from as GraphPortRef,
            to,
            element,
            key: defaultGraphDedupeKey(elementType),
          },
          summary: `Fan-in: a dedupe merge goes between ${facts.label} and ${target.id}.${port.name}`,
        };
      }
      return {
        ok: true,
        plan: { kind: "fan-in-list", from: from as GraphPortRef, to, element },
        summary: `Fan-in: ${target.id}.${port.name} becomes ${listOf(element)} (${element} has no items to dedupe)`,
      };
    }
  }

  if (
    !facts.replicated &&
    stripList(port.type) !== null &&
    fits(library, delivered, stripList(port.type)!).ok
  ) {
    return {
      ok: false,
      reason: "One value into a list is not an edge: replicate the producer to fan out",
    };
  }
  return { ok: false, reason: direct.message ?? "The types do not fit" };
}

// ---------------------------------------------------------------- apply

export interface GraphConnectionResult {
  template: GraphTemplateV1;
  /** What to tell the user (merge inserted, port changed). */
  message: string;
  /** A node the edit created, to select. */
  createdNodeId?: string;
}

function edgeBase(from: GraphEdgeSource, to: string): string {
  const start = isGraphRunInputRef(from) ? from.input : from.node;
  return graphIdFrom(`${start}-${to}`, "edge");
}

function addEdge(
  template: GraphTemplateV1,
  from: GraphEdgeSource,
  to: GraphPortTarget,
  extra: { zip?: boolean } = {},
): GraphTemplateV1 {
  const id = uniqueGraphId(
    edgeBase(from, to.node),
    template.edges.map((edge) => edge.id),
  );
  let next: GraphTemplateV1 = {
    ...template,
    edges: [...template.edges, { id, from, to, ...(extra.zip ? { zip: true } : {}) }],
  };
  next = withLoopEntry(next, to);
  return next;
}

/**
 * Inside a loop, iteration 1 reads a port from outside the region and later
 * iterations from inside it (report §9.2). When a second producer is drawn
 * into such a port, mark the outside one as `firstIterationFrom`.
 */
function withLoopEntry(template: GraphTemplateV1, to: GraphPortTarget): GraphTemplateV1 {
  const loop = graphLoopOf(template, to.node);
  const node = graphNodeById(template, to.node);
  const port = node?.inputs?.find((entry) => entry.name === to.port);
  if (!loop || !port || port.firstIterationFrom || stripList(port.type) !== null) return template;
  const producers = template.edges.filter(
    (edge) => edge.to.node === to.node && edge.to.port === to.port,
  );
  if (producers.length !== 2) return template;
  const outside = producers.filter(
    (edge) => isGraphRunInputRef(edge.from) || !loop.nodes.includes(edge.from.node),
  );
  if (outside.length !== 1) return template;
  return updateGraphNode(
    template,
    to.node,
    (current) =>
      ({
        ...current,
        inputs: current.inputs!.map((entry) =>
          entry.name === to.port ? { ...entry, firstIterationFrom: outside[0]!.from } : entry,
        ),
      }) as GraphNodeSpec,
  );
}

function setInputType(
  template: GraphTemplateV1,
  to: GraphPortTarget,
  type: string,
): GraphTemplateV1 {
  return updateGraphNode(
    template,
    to.node,
    (node) =>
      ({
        ...node,
        inputs: (node.inputs ?? []).map((port) =>
          port.name === to.port ? { ...port, type } : port,
        ),
      }) as GraphNodeSpec,
  );
}

/** A merge fed a list for the first time gets a matching output and dedupe key. */
function fitMergeToInput(
  template: GraphTemplateV1,
  library: GraphTypeLibrary,
  nodeId: string,
  listType: string,
  outputName: string,
): GraphTemplateV1 {
  const element = stripList(listType);
  if (!element) return template;
  return updateGraphNode(template, nodeId, (node) => {
    if (node.kind !== "merge") return node;
    const outputs =
      node.outputs && node.outputs.length > 0
        ? node.outputs
        : [{ name: outputName, type: element }];
    const strategy =
      node.strategy.kind === "dedupe" && (node.outputs?.length ?? 0) === 0
        ? { kind: "dedupe" as const, key: defaultGraphDedupeKey(resolve(library, element)) }
        : node.strategy;
    return { ...node, outputs, strategy };
  });
}

function position(template: GraphTemplateV1, id: string): GraphLayoutPoint {
  return template.layout?.[id] ?? { x: 0, y: 0 };
}

/** Applies a verdict's plan to the template. */
export function applyGraphConnection(
  template: GraphTemplateV1,
  library: GraphTypeLibrary,
  verdict: Extract<GraphConnectionVerdict, { ok: true }>,
): GraphConnectionResult {
  const plan = verdict.plan;
  switch (plan.kind) {
    case "edge":
      return {
        template: addEdge(template, plan.from, plan.to, plan.zip ? { zip: true } : {}),
        message: verdict.summary,
      };
    case "carry":
      return {
        template: updateGraphLoop(template, plan.loopId, (loop) => ({
          ...loop,
          carry: [...loop.carry, { from: plan.from, to: plan.to }],
        })),
        message: verdict.summary,
      };
    case "fan-in-list": {
      let next = setInputType(template, plan.to, listOf(plan.element));
      next = fitMergeToInput(next, library, plan.to.node, listOf(plan.element), plan.from.port);
      return { template: addEdge(next, plan.from, plan.to), message: verdict.summary };
    }
    case "fan-in-merge": {
      const layout = materializeGraphLayout(template);
      const a = layout[plan.from.node] ?? position(template, plan.from.node);
      const b = layout[plan.to.node] ?? position(template, plan.to.node);
      const id = uniqueGraphId(
        graphIdFrom(`${plan.from.node}-dedupe`, "dedupe"),
        template.nodes.map((node) => node.id),
      );
      let next: GraphTemplateV1 = {
        ...template,
        nodes: [
          ...template.nodes,
          {
            id,
            kind: "merge",
            label: `Dedupe ${plan.from.node}`,
            inputs: [{ name: "sources", type: listOf(plan.element) }],
            outputs: [{ name: plan.from.port, type: plan.element }],
            strategy: { kind: "dedupe", key: plan.key },
          },
        ],
        layout: {
          ...layout,
          [id]: { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) + 140 },
        },
      };
      const loop = graphLoopOf(template, plan.from.node);
      if (loop && loop.nodes.includes(plan.to.node)) next = addGraphNodeToLoop(next, id, loop.id);
      next = addEdge(next, plan.from, { node: id, port: "sources" });
      next = addEdge(next, { node: id, port: plan.from.port }, plan.to);
      return {
        template: next,
        message: `Inserted a dedupe merge (${id}) on ${plan.key.join(", ")}: a fan-in defaults to a deterministic merge. Change its strategy in the inspector, or undo.`,
        createdNodeId: id,
      };
    }
    case "new-input": {
      let next = updateGraphNode(
        template,
        plan.node,
        (node) =>
          ({
            ...node,
            inputs: [...(node.inputs ?? []), { name: plan.name, type: plan.type }],
          }) as GraphNodeSpec,
      );
      const base = isGraphRunInputRef(plan.from) ? plan.from.input : plan.from.port;
      next = fitMergeToInput(next, library, plan.node, plan.type, base);
      return {
        template: addEdge(next, plan.from, { node: plan.node, port: plan.name }),
        message: verdict.summary,
      };
    }
    case "run-output": {
      const outputs = plan.existing
        ? (template.outputs ?? []).map((output) =>
            output.name === plan.name ? { ...output, from: plan.from } : output,
          )
        : [...(template.outputs ?? []), { name: plan.name, type: plan.type, from: plan.from }];
      return { template: { ...template, outputs }, message: verdict.summary };
    }
  }
}
