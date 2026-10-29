import type { CompiledGraphPlan, GraphPlanValueType } from "@orkestrator/protocol/graphs/compile";
import { isGraphKey } from "@orkestrator/protocol/graphs/grammar";
import {
  graphLoopPredicateScope,
  graphNodePredicateScope,
  type GraphPredicatePortRoot,
  type GraphPredicateScope,
} from "@orkestrator/protocol/graphs/predicates";
import { graphSchemaNonNull } from "@orkestrator/protocol/graphs/schema-subset";
import {
  graphNodeOutlets,
  isGraphRunInputRef,
  type GraphEdgeSource,
  type GraphLoopRegion,
  type GraphNodeSpec,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import {
  graphListType,
  type GraphTypeLibrary,
  type GraphValueType,
} from "@orkestrator/protocol/graphs/types";

/**
 * Predicate scopes for the editable inspector (item 212), built the way the
 * compiler builds them (`compile-conditions.ts`): a node's `when` and a gate's
 * branches see the node's input ports (the delivered type when the template
 * compiled), `params` and `run`; a loop's `until` sees its members' outputs as
 * `<node>.<port>`. Path suggestions walk the roots' schemas for the predicate
 * builder's autocomplete.
 *
 * Also the outlet helpers: an outlet (of a gate or human node) is named by the
 * edges and run outputs that read it, so renaming or dropping one rewrites or
 * drops those references.
 */

/** A plan value type back to a library type; null when its named type no longer resolves. */
export function graphValueTypeFromPlan(
  type: GraphPlanValueType,
  library: GraphTypeLibrary,
): GraphValueType | null {
  switch (type.kind) {
    case "named": {
      const resolved = library.resolve(type.ref);
      return resolved.ok ? resolved.type : null;
    }
    case "shape":
      return { kind: "shape", schema: type.schema, budgets: type.budgets, origin: type.origin };
    case "list": {
      const element = graphValueTypeFromPlan(type.element, library);
      return element ? graphListType(element) : null;
    }
  }
}

/** The `choices` of the decision output feeding a port, when every producer agrees. */
function producerChoices(
  template: GraphTemplateV1,
  nodeId: string,
  port: string,
): string[] | undefined {
  const producers = template.edges.filter(
    (edge) => edge.to.node === nodeId && edge.to.port === port,
  );
  const choices = producers.map((edge) => {
    const from = edge.from;
    if (isGraphRunInputRef(from) || from.outlet !== undefined) return undefined;
    const source = template.nodes.find((node) => node.id === from.node);
    if (!source || !("outputs" in source)) return undefined;
    return source.outputs?.find((output) => output.name === from.port)?.choices;
  });
  const first = choices[0];
  return first !== undefined && choices.every((entry) => entry === first) ? first : undefined;
}

/** Scope of a node's `when` or a gate branch: its input ports, `params` and `run`. */
export function graphNodePredicateScopeFor(
  template: GraphTemplateV1,
  library: GraphTypeLibrary,
  node: GraphNodeSpec,
  plan: CompiledGraphPlan | null,
): GraphPredicateScope {
  const planNode = plan?.nodes.find((candidate) => candidate.id === node.id);
  const roots: GraphPredicatePortRoot[] = (node.inputs ?? []).map((port) => {
    const delivered = planNode?.inputs.find((entry) => entry.name === port.name)?.deliveredType;
    const type = delivered ? graphValueTypeFromPlan(delivered, library) : null;
    const choices = producerChoices(template, node.id, port.name);
    return { name: port.name, type: type ?? port.type, ...(choices ? { choices } : {}) };
  });
  return graphNodePredicateScope(roots, template.parameters, library);
}

function isReplicated(node: GraphNodeSpec): boolean {
  return (node.kind === "agent" || node.kind === "subgraph") && node.replicate !== undefined;
}

/** Scope of a loop's `until`: outputs of its members as `<node>.<port>`, `params` and `run`. */
export function graphLoopPredicateScopeFor(
  template: GraphTemplateV1,
  library: GraphTypeLibrary,
  loop: GraphLoopRegion,
): GraphPredicateScope {
  const outputs = loop.nodes.flatMap((member) => {
    const node = template.nodes.find((candidate) => candidate.id === member);
    if (!node || !("outputs" in node)) return [];
    return (node.outputs ?? []).map((port) => {
      const resolved = library.resolve(port.type);
      const type: GraphValueType | string = resolved.ok
        ? isReplicated(node)
          ? graphListType(resolved.type)
          : resolved.type
        : port.type;
      return {
        node: member,
        port: port.name,
        type,
        ...(port.choices ? { choices: port.choices } : {}),
      };
    });
  });
  return graphLoopPredicateScope(outputs, template.parameters, library);
}

export interface GraphPathSuggestion {
  path: string;
  /** For display: `string`, `integer`, `array`, `string | null`, … */
  type: string;
}

const MAX_SUGGESTIONS = 400;

function schemaTypeLabel(schema: Record<string, unknown>): string {
  const { schema: inner, nullable } = graphSchemaNonNull(schema);
  let label: string;
  if (typeof inner.type === "string") label = inner.type;
  else if (Array.isArray(inner.anyOf)) label = "any of";
  else label = "unknown";
  if (Array.isArray(inner.enum)) label += ` (${inner.enum.map(String).join(" | ")})`.slice(0, 80);
  return nullable ? `${label} | null` : label;
}

/** Paths a predicate may name in `scope`: root names, then object fields to `maxDepth`. */
export function graphPredicatePathSuggestions(
  scope: GraphPredicateScope,
  maxDepth = 4,
): GraphPathSuggestion[] {
  const out: GraphPathSuggestion[] = [];
  const walk = (schema: Record<string, unknown>, prefix: string, depth: number) => {
    if (depth >= maxDepth) return;
    const inner = graphSchemaNonNull(schema).schema;
    const properties = inner.properties;
    if (inner.type !== "object" || !properties || typeof properties !== "object") return;
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      if (out.length >= MAX_SUGGESTIONS) return;
      if (!child || typeof child !== "object" || Array.isArray(child)) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      out.push({ path, type: schemaTypeLabel(child as Record<string, unknown>) });
      walk(child as Record<string, unknown>, path, depth + 1);
    }
  };
  if (scope.kind === "element") {
    if (scope.schema) walk(scope.schema, "", 0);
    return out;
  }
  for (const root of scope.roots) {
    if (out.length >= MAX_SUGGESTIONS) break;
    out.push({ path: root.name, type: root.schema ? schemaTypeLabel(root.schema) : root.label });
    if (root.schema) walk(root.schema, root.name, 0);
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

// ---------------------------------------------------------------- outlets

function readsOutlet(source: GraphEdgeSource, nodeId: string, outlet: string): boolean {
  return !isGraphRunInputRef(source) && source.node === nodeId && source.outlet === outlet;
}

/**
 * Renames an outlet of a gate (branch `to` or `otherwise`) or a `choose`
 * human node (an option's `to`), and the edges and run outputs that read it.
 */
export function renameGraphOutlet(
  template: GraphTemplateV1,
  nodeId: string,
  from: string,
  to: string,
): GraphTemplateV1 {
  if (from === to) return template;
  const nodes = template.nodes.map((node): GraphNodeSpec => {
    if (node.id !== nodeId) return node;
    if (node.kind === "gate") {
      return {
        ...node,
        branches: node.branches.map((branch) => (branch.to === from ? { ...branch, to } : branch)),
        ...(node.otherwise === from ? { otherwise: to } : {}),
      };
    }
    if (node.kind === "human" && node.form.kind === "choose") {
      return {
        ...node,
        form: {
          ...node.form,
          options: node.form.options.map((option) =>
            option.to === from ? { ...option, to } : option,
          ),
        },
      };
    }
    return node;
  });
  return {
    ...template,
    nodes,
    edges: template.edges.map((edge) =>
      readsOutlet(edge.from, nodeId, from) ? { ...edge, from: { ...edge.from, outlet: to } } : edge,
    ),
    outputs: (template.outputs ?? []).map((output) =>
      readsOutlet(output.from, nodeId, from)
        ? { ...output, from: { ...output.from, outlet: to } }
        : output,
    ),
  };
}

/** Drops the edges and run outputs that read one outlet of a node. */
export function removeGraphOutlet(
  template: GraphTemplateV1,
  nodeId: string,
  outlet: string,
): GraphTemplateV1 {
  return {
    ...template,
    edges: template.edges.filter((edge) => !readsOutlet(edge.from, nodeId, outlet)),
    outputs: (template.outputs ?? []).filter((output) => !readsOutlet(output.from, nodeId, outlet)),
  };
}

/** Drops references to outlets the node no longer has (after a form or branch change). */
export function pruneGraphOutletReferences(
  template: GraphTemplateV1,
  nodeId: string,
): GraphTemplateV1 {
  const node = template.nodes.find((candidate) => candidate.id === nodeId);
  const outlets = new Set(node ? (graphNodeOutlets(node) ?? []) : []);
  const stale = (source: GraphEdgeSource) =>
    !isGraphRunInputRef(source) &&
    source.node === nodeId &&
    source.outlet !== undefined &&
    !outlets.has(source.outlet);
  const edges = template.edges.filter((edge) => !stale(edge.from));
  const outputs = (template.outputs ?? []).filter((output) => !stale(output.from));
  if (
    edges.length === template.edges.length &&
    outputs.length === (template.outputs ?? []).length
  ) {
    return template;
  }
  return { ...template, edges, outputs };
}

/** Validates a new outlet name: an identifier the node does not use yet. */
export function graphOutletValidator(node: GraphNodeSpec, current: string) {
  const outlets = new Set(graphNodeOutlets(node) ?? []);
  return (text: string) =>
    !isGraphKey(text)
      ? "An identifier: a lower-case letter, then letters, digits or _"
      : text !== current && outlets.has(text)
        ? `${node.id} already has an outlet ${text}`
        : null;
}
