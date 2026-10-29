/**
 * Compiler pass 0 (item 402): inline every sub-graph node.
 *
 * `inlineGraphSubgraphs` rewrites a guarded template into a flat one the
 * other passes check unchanged. Each sub-graph node `s` is replaced by its
 * child's nodes, edges and loops under ids `s/<child id>`; edges into `s.p`
 * are rewired to the child's consumers of run input `p`, edges out of `s.q`
 * to the source of the child's run output `q`; child roles map to parent
 * roles and child parameters to a scope of literals and parent parameters
 * the plan records. Nested sub-graphs are flattened first, depth-bounded and
 * checked for recursion.
 *
 * A sub-graph node that cannot be inlined (unresolved child, bad bindings,
 * unsupported options) stays in the flat template as an opaque node, so its
 * declared ports are still checked; the compile then has an error and no
 * plan. Diagnostics here are written in the author's terms: inlined entries
 * carry paths like `nodes[4]>nodes[2]`, and `mapPath` translates the flat
 * template's paths the later passes report back into those.
 */
import { canonicalJson } from "../canonical-json.js";
import type { ArtifactTypeDef } from "./artifact-type-def.js";
import {
  GRAPH_COMPILE_DIAGNOSTICS,
  type GraphCompileDiagnostic,
  type GraphCompileDiagnosticCode,
  type GraphDiagnosticLocation,
} from "./compile-diagnostics.js";
import {
  GRAPH_PLAN_BOUNDS,
  GRAPH_PLAN_ID_MAX_CHARS,
  GRAPH_TEMPLATE_BOUNDS as B,
  graphUtf8Bytes,
} from "./grammar.js";
import { type GraphPlanParamSource, type GraphPlanSubgraph, graphTemplateDigest } from "./plan.js";
import type { GraphPredicate } from "./predicate-shape.js";
import {
  GRAPH_SUBGRAPH_MAX_DEPTH,
  GRAPH_SUBGRAPH_MAX_RESOLUTIONS,
  type GraphTemplateResolution,
  type GraphTemplateResolver,
  graphSubgraphRefKey,
} from "./subgraphs.js";
import {
  type GraphEdgeSource,
  type GraphEdgeSpec,
  type GraphInputPortSpec,
  type GraphLoopRegion,
  type GraphNodeSpec,
  type GraphParameter,
  type GraphPortRef,
  type GraphPortTarget,
  type GraphReplicateAxis,
  type GraphRunOutputSpec,
  type GraphScalarValue,
  type GraphSubgraphNode,
  type GraphTemplateRef,
  type GraphTemplateV1,
  isGraphRunInputRef,
} from "./template-model.js";
import { validateGraphTemplate } from "./template.js";

/** An inlined instance, ids relative to the template being flattened. */
export type GraphInlinedSubgraph = Omit<GraphPlanSubgraph, "nodes">;

export interface GraphSubgraphInlineResult {
  /** The flat template; the input itself when it has no sub-graph nodes. */
  template: GraphTemplateV1;
  /** Flat template paths → the author's template paths; null when nothing moved. */
  mapPath: ((path: string) => string) | null;
  /** Every inlined instance, outermost first, with plan ids. */
  subgraphs: GraphInlinedSubgraph[];
  /** Inlined node or loop id → its innermost instance. */
  nodeSubgraph: ReadonlyMap<string, string>;
  loopSubgraph: ReadonlyMap<string, string>;
  /** Diagnostics in the author's terms. */
  diagnostics: GraphCompileDiagnostic[];
}

interface Located<T> {
  value: T;
  /** Path in the author's template. */
  path: string;
}

/** One template flattened, ids relative to it. */
interface FlatTemplate {
  nodes: Located<GraphNodeSpec>[];
  edges: Located<GraphEdgeSpec>[];
  loops: Located<GraphLoopRegion>[];
  types: Located<ArtifactTypeDef>[];
  /** Run outputs with sources rewritten to flat ids. */
  outputs: GraphRunOutputSpec[];
  subgraphs: GraphInlinedSubgraph[];
  nodeSubgraph: Map<string, string>;
  loopSubgraph: Map<string, string>;
}

interface Frame {
  /** Author path prefix of this template's entries (`""`, `nodes[4]>`). */
  path: string;
  /** Plan id prefix of this template's nodes (`""`, `review/`). */
  id: string;
  depth: number;
  /** Reference keys being flattened, outermost first. */
  stack: string[];
}

interface Context {
  resolve: GraphTemplateResolver | undefined;
  cache: Map<string, GraphTemplateResolution | undefined>;
  diagnostics: GraphCompileDiagnostic[];
  /** Child nodes inlined so far at every level: bounds the work of deep nesting. */
  inlined: number;
}

interface Expansion {
  node: GraphSubgraphNode;
  path: string;
  child: GraphTemplateV1;
  digest: string;
  revision: number;
  resolvedPath?: string;
  flat: FlatTemplate;
  params: Record<string, GraphPlanParamSource>;
  roles: Record<string, string>;
}

const PREDICATE_RESERVED_ROOTS = new Set(["params", "run"]);
const UNSUPPORTED_FIELDS = ["replicate", "when", "retry", "timeoutMs", "onFailure"] as const;

function report(
  context: Context,
  code: GraphCompileDiagnosticCode,
  message: string,
  at: GraphDiagnosticLocation,
): void {
  context.diagnostics.push({
    code,
    severity: GRAPH_COMPILE_DIAGNOSTICS[code].severity,
    message,
    ...at,
  });
}

const typeRef = (def: ArtifactTypeDef) => `${def.name}@${def.version}`;
const isRequired = (port: { required?: boolean }) => port.required !== false;

// ---------------------------------------------------------------- resolution

function resolveChild(
  context: Context,
  ref: GraphTemplateRef,
): GraphTemplateResolution | undefined | "too-many" {
  if (!context.resolve) return { missing: "no-resolver" };
  const key = graphSubgraphRefKey(ref);
  if (context.cache.has(key)) return context.cache.get(key);
  if (context.cache.size >= GRAPH_SUBGRAPH_MAX_RESOLUTIONS) return "too-many";
  let resolution: GraphTemplateResolution | undefined;
  try {
    resolution = context.resolve(ref);
  } catch {
    resolution = undefined;
  }
  context.cache.set(key, resolution);
  return resolution;
}

const MISSING_TEXT: Readonly<Record<string, string>> = {
  "not-found": "does not exist",
  untrusted: "is a project template that is not trusted at its current content; trust it first",
  ambiguous: "names more than one project template; pin its path",
  "no-project": "is a project template, and this compile has no project",
  "no-resolver": "cannot be looked up here (this compile has no template resolver)",
};

// ---------------------------------------------------------------- bindings

function literalProblem(value: GraphScalarValue, parameter: GraphParameter): string | null {
  if (value === null) return "needs a value, not null";
  switch (parameter.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "is a boolean";
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return `is ${parameter.type === "integer" ? "an integer" : "a number"}`;
      if (parameter.type === "integer" && !Number.isSafeInteger(value)) return "is an integer";
      if (parameter.min !== undefined && value < parameter.min)
        return `is at least ${parameter.min}`;
      if (parameter.max !== undefined && value > parameter.max)
        return `is at most ${parameter.max}`;
      return null;
    }
    case "string": {
      if (typeof value !== "string") return "is a string";
      const max = parameter.maxBytes ?? B.maxStringParameterBytes;
      return graphUtf8Bytes(value) <= max ? null : `is at most ${max} bytes`;
    }
    case "enum":
      return typeof value === "string" && parameter.options.includes(value)
        ? null
        : `is one of ${parameter.options.join(", ")}`;
  }
}

/** Why a parent parameter cannot feed a child parameter, or null when it fits. */
function passThroughProblem(source: GraphParameter, target: GraphParameter): string | null {
  const sameType =
    source.type === target.type || (target.type === "number" && source.type === "integer");
  if (!sameType) return `is ${target.type} and ${source.key} is ${source.type}`;
  if (source.type === "enum" && target.type === "enum") {
    const extra = source.options.filter((option) => !target.options.includes(option));
    return extra.length === 0 ? null : `does not accept ${extra.join(", ")}`;
  }
  if (
    (source.type === "integer" || source.type === "number") &&
    (target.type === "integer" || target.type === "number")
  ) {
    if (target.min !== undefined && (source.min === undefined || source.min < target.min)) {
      return `needs at least ${target.min}; give ${source.key} that minimum`;
    }
    if (target.max !== undefined && (source.max === undefined || source.max > target.max)) {
      return `needs at most ${target.max}; give ${source.key} that maximum`;
    }
  }
  if (source.type === "string" && target.type === "string" && target.maxBytes !== undefined) {
    if ((source.maxBytes ?? B.maxStringParameterBytes) > target.maxBytes) {
      return `takes at most ${target.maxBytes} bytes; give ${source.key} that maxBytes`;
    }
  }
  return null;
}

function bindParams(
  context: Context,
  parent: GraphTemplateV1,
  expansion: Pick<Expansion, "node" | "path" | "child">,
  at: GraphDiagnosticLocation,
): Record<string, GraphPlanParamSource> | null {
  const { node, child, path } = expansion;
  const own = new Map(parent.parameters.map((parameter) => [parameter.key, parameter]));
  const inner = new Map(child.parameters.map((parameter) => [parameter.key, parameter]));
  const scope: Record<string, GraphPlanParamSource> = {};
  let ok = true;
  const fail = (message: string, where: string) => {
    ok = false;
    report(context, "subgraph-param-binding", message, { ...at, path: where });
  };
  for (const [key, binding] of Object.entries(node.params ?? {})) {
    const where = `${path}.params.${key}`;
    const target = inner.get(key);
    if (!target) {
      fail(`${child.name} has no parameter ${key}`, where);
      continue;
    }
    if (binding !== null && typeof binding === "object") {
      const source = own.get(binding.param);
      if (!source) {
        fail(`This template has no parameter ${binding.param} to pass to ${key}`, where);
        continue;
      }
      const problem = passThroughProblem(source, target);
      if (problem) fail(`${child.name}'s parameter ${key} ${problem}`, where);
      else scope[key] = { param: binding.param };
      continue;
    }
    const problem = literalProblem(binding, target);
    if (problem) fail(`${child.name}'s parameter ${key} ${problem}`, where);
    else scope[key] = { value: binding as string | number | boolean };
  }
  for (const parameter of child.parameters) {
    if (parameter.key in scope || node.params?.[parameter.key] !== undefined) continue;
    if (parameter.default !== undefined) {
      scope[parameter.key] = { value: parameter.default };
    } else {
      fail(
        `${child.name}'s parameter ${parameter.key} has no default; bind it to a value or to one of this template's parameters`,
        `${path}.params`,
      );
    }
  }
  return ok ? scope : null;
}

function bindRoles(
  context: Context,
  parent: GraphTemplateV1,
  expansion: Pick<Expansion, "node" | "path" | "child">,
  at: GraphDiagnosticLocation,
): Record<string, string> | null {
  const { node, child, path } = expansion;
  const own = new Map(parent.roles.map((role) => [role.key, role]));
  const inner = new Set(child.roles.map((role) => role.key));
  let ok = true;
  const fail = (message: string, where: string) => {
    ok = false;
    report(context, "subgraph-role-binding", message, { ...at, path: where });
  };
  for (const [key, outer] of Object.entries(node.roles ?? {})) {
    if (!inner.has(key)) fail(`${child.name} has no role ${key}`, `${path}.roles.${key}`);
    if (!own.has(outer))
      fail(`There is no role ${outer} to bind ${key} to`, `${path}.roles.${key}`);
  }
  const roles: Record<string, string> = {};
  for (const role of child.roles) {
    const target = node.roles?.[role.key] ?? (own.has(role.key) ? role.key : undefined);
    const where =
      node.roles?.[role.key] !== undefined ? `${path}.roles.${role.key}` : `${path}.roles`;
    const outer = target === undefined ? undefined : own.get(target);
    if (!outer) {
      if (target === undefined) {
        fail(
          `${child.name}'s role ${role.key} is unbound: bind it to one of this template's roles`,
          where,
        );
      }
      continue;
    }
    if (outer.multiplicity !== role.multiplicity) {
      fail(
        `${child.name}'s role ${role.key} binds ${role.multiplicity === "panel" ? "a panel" : "one model"}; ${outer.key} binds ${outer.multiplicity === "panel" ? "a panel" : "one model"}`,
        where,
      );
      continue;
    }
    const innerMax = role.maxPanel ?? B.maxBranches;
    const outerMax = outer.maxPanel ?? B.maxBranches;
    if (role.multiplicity === "panel" && outerMax > innerMax) {
      fail(
        `${child.name}'s panel ${role.key} takes at most ${innerMax} models; ${outer.key} allows ${outerMax}`,
        where,
      );
      continue;
    }
    roles[role.key] = outer.key;
  }
  return ok ? roles : null;
}

function checkPorts(
  context: Context,
  expansion: Pick<Expansion, "node" | "path" | "child">,
  at: GraphDiagnosticLocation,
): boolean {
  const { node, child, path } = expansion;
  let ok = true;
  const fail = (message: string, where: string, port?: string) => {
    ok = false;
    report(context, "subgraph-port-mismatch", message, {
      ...at,
      path: where,
      ...(port !== undefined ? { port } : {}),
    });
  };
  const runInputs = new Map(child.inputs.map((input) => [input.name, input]));
  const declaredInputs = new Set<string>();
  (node.inputs ?? []).forEach((port, index) => {
    const where = `${path}.inputs[${index}]`;
    declaredInputs.add(port.name);
    const input = runInputs.get(port.name);
    if (!input) {
      fail(
        `${child.name} has no run input ${port.name} (it has ${child.inputs.map((entry) => entry.name).join(", ") || "none"})`,
        `${where}.name`,
        port.name,
      );
      return;
    }
    if (input.type !== port.type) {
      fail(`${child.name} takes ${port.name} as ${input.type}`, `${where}.type`, port.name);
    }
    if (isRequired(input) && !isRequired(port)) {
      fail(`${child.name} requires ${port.name}; the port cannot be optional`, where, port.name);
    }
    if (port.render !== undefined || port.collect !== undefined) {
      fail(
        `A sub-graph port does not render or collect; the child's own consumers of ${port.name} decide`,
        where,
        port.name,
      );
    }
  });
  for (const input of child.inputs) {
    if (isRequired(input) && !declaredInputs.has(input.name)) {
      fail(
        `${child.name} needs its run input ${input.name}: add the port`,
        `${path}.inputs`,
        input.name,
      );
    }
  }
  const runOutputs = new Map((child.outputs ?? []).map((output) => [output.name, output]));
  (node.outputs ?? []).forEach((port, index) => {
    const where = `${path}.outputs[${index}]`;
    const output = runOutputs.get(port.name);
    if (!output) {
      fail(
        `${child.name} has no run output ${port.name} (it has ${(child.outputs ?? []).map((entry) => entry.name).join(", ") || "none"})`,
        `${where}.name`,
        port.name,
      );
      return;
    }
    if (output.type !== port.type) {
      fail(`${child.name} returns ${port.name} as ${output.type}`, `${where}.type`, port.name);
    }
    if (!isRequired(output) && isRequired(port)) {
      fail(
        `${child.name}'s ${port.name} is optional (it may be skipped); mark the port required: false`,
        where,
        port.name,
      );
    }
    if (port.provenance !== undefined || port.choices !== undefined) {
      fail(
        `A sub-graph output has no provenance or choices of its own; the child's producer of ${port.name} declares them`,
        where,
        port.name,
      );
    }
  });
  return ok;
}

// ---------------------------------------------------------------- expansion

function expand(
  context: Context,
  parent: GraphTemplateV1,
  node: GraphSubgraphNode,
  index: number,
  loopOf: ReadonlyMap<string, string>,
  frame: Frame,
): Expansion | null {
  const path = `${frame.path}nodes[${index}]`;
  const at: GraphDiagnosticLocation = { nodeId: `${frame.id}${node.id}`, path };
  let ok = true;
  for (const field of UNSUPPORTED_FIELDS) {
    if (node[field] === undefined) continue;
    ok = false;
    report(
      context,
      "subgraph-unsupported",
      `A sub-graph node cannot use ${field}: inlining replaces the node by the child's own nodes. Set it on those nodes in the child template.`,
      { ...at, path: `${path}.${field}` },
    );
  }
  if (frame.depth >= GRAPH_SUBGRAPH_MAX_DEPTH) {
    report(context, "subgraph-depth", `Sub-graphs nest at most ${GRAPH_SUBGRAPH_MAX_DEPTH} deep`, {
      ...at,
      path: `${path}.template`,
    });
    return null;
  }
  const ref = node.template;
  const resolution = resolveChild(context, ref);
  const refText = `${ref.scope} template ${ref.path ?? ref.id}`;
  if (resolution === "too-many") {
    report(
      context,
      "subgraph-too-large",
      `A compile resolves at most ${GRAPH_SUBGRAPH_MAX_RESOLUTIONS} distinct sub-graph templates`,
      { ...at, path: `${path}.template` },
    );
    return null;
  }
  if (!resolution || "missing" in resolution) {
    const reason = resolution ? resolution.missing : "not-found";
    report(context, "subgraph-unresolved", `The ${refText} ${MISSING_TEXT[reason]}`, {
      ...at,
      path: `${path}.template`,
      detail: reason,
    });
    return null;
  }
  const guard = validateGraphTemplate(resolution.template);
  if (!guard.ok) {
    report(
      context,
      "subgraph-unresolved",
      `The ${refText} is not a valid template (${guard.errors.length + guard.omittedErrors} schema errors); open it to fix it`,
      { ...at, path: `${path}.template`, detail: "invalid" },
    );
    return null;
  }
  const child = guard.value;
  if (child.id !== ref.id) {
    report(
      context,
      "subgraph-unresolved",
      `The ${refText} holds template ${child.id}, not ${ref.id}`,
      { ...at, path: `${path}.template.id`, detail: "not-found" },
    );
    return null;
  }
  const key = graphSubgraphRefKey(ref);
  if (frame.stack.includes(key)) {
    report(
      context,
      "subgraph-recursive",
      `${child.name} contains itself (${[...frame.stack, key].join(" → ")})`,
      { ...at, path: `${path}.template` },
    );
    return null;
  }
  const digest = graphTemplateDigest(child);
  const revision = resolution.revision ?? child.revision;
  if (ref.digest !== undefined && ref.digest !== digest) {
    ok = false;
    report(
      context,
      "subgraph-digest-mismatch",
      `${child.name} changed since this node pinned it (digest ${ref.digest.slice(0, 12)}…, now ${digest.slice(0, 12)}…); review the change and re-pin it`,
      { ...at, path: `${path}.template.digest` },
    );
  }
  if (ref.revision !== undefined && ref.revision !== revision) {
    ok = false;
    report(
      context,
      "subgraph-digest-mismatch",
      `This node pins revision ${ref.revision} of ${child.name}, which is now at revision ${revision}; review the change and re-pin it`,
      { ...at, path: `${path}.template.revision` },
    );
  }
  if (ref.digest === undefined) {
    report(
      context,
      "subgraph-unpinned",
      `${child.name} is not pinned: each compile uses its current content (digest ${digest.slice(0, 12)}…). A run still freezes what it launched with.`,
      { ...at, path: `${path}.template` },
    );
  }
  if (child.engine !== undefined) {
    report(
      context,
      "subgraph-engine-copy",
      `${child.name} runs on its own engine when launched alone; here a copy of its nodes runs on the graph runtime`,
      { ...at, path: `${path}.template` },
    );
  }
  if (child.workspace.kind === "environment" && parent.workspace.kind === "none") {
    ok = false;
    report(
      context,
      "subgraph-workspace",
      `${child.name} works in an environment; give this template an environment workspace`,
      { ...at, path: `${path}.template` },
    );
  }
  const base = { node, path, child };
  if (!checkPorts(context, base, at)) ok = false;
  const params = bindParams(context, parent, base, at);
  const roles = bindRoles(context, parent, base, at);
  if (!ok || !params || !roles) return null;

  const flat = flatten(context, child, {
    path: `${path}>`,
    id: `${frame.id}${node.id}/`,
    depth: frame.depth + 1,
    stack: [...frame.stack, key],
  });
  if (loopOf.has(node.id) && flat.loops.length > 0) {
    report(
      context,
      "subgraph-unsupported",
      `${child.name} has loops of its own and this node is inside loop ${loopOf.get(node.id)}; loops do not nest`,
      at,
    );
    return null;
  }
  const longest = flat.nodes.reduce((max, entry) => Math.max(max, entry.value.id.length), 0);
  if (frame.id.length + node.id.length + 1 + longest > GRAPH_PLAN_ID_MAX_CHARS) {
    report(
      context,
      "subgraph-too-large",
      `Inlined node ids would exceed ${GRAPH_PLAN_ID_MAX_CHARS} characters; shorten this node's id or the child's`,
      { ...at, path: `${path}.id` },
    );
    return null;
  }
  context.inlined += flat.nodes.length;
  if (context.inlined > 4 * GRAPH_PLAN_BOUNDS.maxNodes) {
    report(
      context,
      "subgraph-too-large",
      `Inlining these sub-graphs produces more than ${GRAPH_PLAN_BOUNDS.maxNodes} nodes`,
      at,
    );
    return null;
  }
  return {
    node,
    path,
    child,
    digest,
    revision,
    ...(resolution.path !== undefined ? { resolvedPath: resolution.path } : {}),
    flat,
    params,
    roles,
  };
}

// ---------------------------------------------------------------- rewriting

function mapPredicateRoots(
  predicate: GraphPredicate,
  rewrite: (path: string) => string,
): GraphPredicate {
  if ("all" in predicate) {
    return { all: predicate.all.map((entry) => mapPredicateRoots(entry, rewrite)) };
  }
  if ("any" in predicate) {
    return { any: predicate.any.map((entry) => mapPredicateRoots(entry, rewrite)) };
  }
  if ("not" in predicate) return { not: mapPredicateRoots(predicate.not, rewrite) };
  return { ...predicate, path: rewrite(predicate.path) };
}

function mapRole(role: string, roles: Readonly<Record<string, string>>): string {
  return roles[role] ?? role;
}

function mapAxis(
  axis: GraphReplicateAxis,
  roles: Readonly<Record<string, string>>,
): GraphReplicateAxis {
  if (axis.over === "panel") return { ...axis, role: mapRole(axis.role, roles) };
  if (axis.over === "lenses") {
    return {
      ...axis,
      lenses: axis.lenses.map((lens) =>
        lens.role === undefined ? lens : { ...lens, role: mapRole(lens.role, roles) },
      ),
    };
  }
  return axis;
}

/** A child node under its plan id prefix, its roles and references mapped. */
function inlineNode(
  node: GraphNodeSpec,
  prefix: string,
  roles: Readonly<Record<string, string>>,
  firstFrom: (port: GraphInputPortSpec) => GraphEdgeSource | undefined,
): GraphNodeSpec {
  const copy = structuredClone(node) as GraphNodeSpec;
  copy.id = `${prefix}${node.id}`;
  if (copy.inputs) {
    copy.inputs = copy.inputs.map((port) => {
      const { firstIterationFrom: _first, ...rest } = port;
      const first = firstFrom(port);
      return first === undefined ? rest : { ...rest, firstIterationFrom: first };
    });
  }
  if (copy.kind === "agent") {
    copy.role = mapRole(copy.role, roles);
    if (copy.session?.mode === "continue") {
      copy.session = { mode: "continue", from: `${prefix}${copy.session.from}` };
    }
  }
  if ((copy.kind === "agent" || copy.kind === "subgraph") && copy.replicate) {
    copy.replicate =
      copy.replicate.over === "cross"
        ? { over: "cross", axes: copy.replicate.axes.map((axis) => mapAxis(axis, roles)) }
        : mapAxis(copy.replicate, roles);
  }
  if (copy.kind === "subgraph" && copy.roles) {
    copy.roles = Object.fromEntries(
      Object.entries(copy.roles).map(([inner, outer]) => [inner, mapRole(outer, roles)]),
    );
  }
  return copy;
}

const prefixRef = (ref: GraphPortRef, prefix: string): GraphPortRef => ({
  ...ref,
  node: `${prefix}${ref.node}`,
});

const prefixTarget = (target: GraphPortTarget, prefix: string): GraphPortTarget => ({
  node: `${prefix}${target.node}`,
  port: target.port,
});

function prefixPredicate(predicate: GraphPredicate, prefix: string): GraphPredicate {
  return mapPredicateRoots(predicate, (path) => {
    const dot = path.indexOf(".");
    const root = dot < 0 ? path : path.slice(0, dot);
    return PREDICATE_RESERVED_ROOTS.has(root) ? path : `${prefix}${path}`;
  });
}

// ---------------------------------------------------------------- flattening

function flatten(context: Context, template: GraphTemplateV1, frame: Frame): FlatTemplate {
  const loopOf = new Map<string, string>();
  for (const loop of template.loops ?? []) {
    for (const member of loop.nodes) if (!loopOf.has(member)) loopOf.set(member, loop.id);
  }
  const expansions = new Map<string, Expansion>();
  template.nodes.forEach((node, index) => {
    if (node.kind !== "subgraph") return;
    const expansion = expand(context, template, node, index, loopOf, frame);
    if (expansion) expansions.set(node.id, expansion);
  });
  const nodePath = (index: number) => `${frame.path}nodes[${index}]`;
  const plain = (index: number) => ({ nodeId: `${frame.id}${template.nodes[index]!.id}` });

  // Edges and carries into each sub-graph input, and its consumers inside.
  const producers = new Map<string, number>();
  const firstEdgeSource = new Map<string, GraphEdgeSource>();
  const countInto = (node: string, port: string) =>
    producers.set(`${node}.${port}`, (producers.get(`${node}.${port}`) ?? 0) + 1);
  for (const edge of template.edges) {
    if (!expansions.has(edge.to.node)) continue;
    countInto(edge.to.node, edge.to.port);
    firstEdgeSource.set(`${edge.to.node}.${edge.to.port}`, edge.from);
  }
  for (const loop of template.loops ?? []) {
    for (const carry of loop.carry) {
      if (expansions.has(carry.to.node)) countInto(carry.to.node, carry.to.port);
    }
  }
  const consumers = (expansion: Expansion, port: string) =>
    expansion.flat.edges.filter(
      (entry) => isGraphRunInputRef(entry.value.from) && entry.value.from.input === port,
    );
  const declaredInput = (expansion: Expansion, port: string) =>
    (expansion.node.inputs ?? []).some((entry) => entry.name === port);
  const declaredOutput = (expansion: Expansion, port: string) =>
    (expansion.node.outputs ?? []).some((entry) => entry.name === port);
  /** The plan source of a sub-graph output (relative to this template). */
  const exposed = (expansion: Expansion, port: string): GraphPortRef | undefined => {
    const output = expansion.flat.outputs.find((entry) => entry.name === port);
    return output ? prefixRef(output.from, `${expansion.node.id}/`) : undefined;
  };
  /** A source in this template, with sub-graph outputs replaced by what they read. */
  const rewriteSource = <T extends GraphEdgeSource>(source: T): T | GraphPortRef => {
    if (isGraphRunInputRef(source)) return source;
    const expansion = expansions.get(source.node);
    if (!expansion || !declaredOutput(expansion, source.port)) return source;
    return exposed(expansion, source.port) ?? source;
  };
  const undeclaredOutput = (source: GraphEdgeSource): string | null => {
    if (isGraphRunInputRef(source)) return null;
    const expansion = expansions.get(source.node);
    return expansion && !declaredOutput(expansion, source.port) ? source.port : null;
  };

  // ---- nodes
  const nodes: Located<GraphNodeSpec>[] = [];
  template.nodes.forEach((node, index) => {
    const expansion = node.kind === "subgraph" ? expansions.get(node.id) : undefined;
    if (!expansion) {
      nodes.push({ value: rewriteParentNode(node, index), path: nodePath(index) });
      return;
    }
    const prefix = `${node.id}/`;
    // `firstIterationFrom` on the sub-graph's own input moves to its consumers.
    const pushedFirst = new Map<string, GraphEdgeSource>();
    for (const port of node.inputs ?? []) {
      if (!port.firstIterationFrom) continue;
      for (const consumer of consumers(expansion, port.name)) {
        pushedFirst.set(
          `${consumer.value.to.node}.${consumer.value.to.port}`,
          rewriteSource(port.firstIterationFrom),
        );
      }
    }
    for (const entry of expansion.flat.nodes) {
      const childNode = entry.value;
      nodes.push({
        value: inlineNode(childNode, prefix, expansion.roles, (port) => {
          const pushed = pushedFirst.get(`${childNode.id}.${port.name}`);
          const own = port.firstIterationFrom;
          if (pushed !== undefined && own !== undefined) {
            report(
              context,
              "subgraph-unsupported",
              `${port.name} of ${childNode.id} already names its first-iteration source; the sub-graph port cannot set another`,
              { nodeId: `${frame.id}${node.id}`, path: expansion.path },
            );
          }
          if (own === undefined) return pushed;
          if (!isGraphRunInputRef(own)) return prefixRef(own, prefix);
          const key = `${node.id}.${own.input}`;
          const count = producers.get(key) ?? 0;
          if (count === 0) return undefined;
          if (count > 1) {
            report(
              context,
              "subgraph-unsupported",
              `${port.name} of ${childNode.id} reads run input ${own.input} on the first iteration, and several producers feed it here`,
              { nodeId: `${frame.id}${node.id}`, path: expansion.path },
            );
            return undefined;
          }
          const source = firstEdgeSource.get(key);
          return source === undefined ? undefined : rewriteSource(source);
        }),
        path: entry.path,
      });
    }
  });

  function rewriteParentNode(node: GraphNodeSpec, index: number): GraphNodeSpec {
    let copy: GraphNodeSpec = node;
    const inputs = node.inputs?.map((port) => {
      if (!port.firstIterationFrom) return port;
      const first = rewriteSource(port.firstIterationFrom);
      return first === port.firstIterationFrom ? port : { ...port, firstIterationFrom: first };
    });
    if (inputs && inputs.some((port, at) => port !== node.inputs![at])) {
      copy = { ...node, inputs } as GraphNodeSpec;
    }
    if (
      node.kind === "agent" &&
      node.session?.mode === "continue" &&
      expansions.has(node.session.from)
    ) {
      report(
        context,
        "subgraph-unsupported",
        `A session cannot continue from sub-graph ${node.session.from}; continue from one of its agent nodes inside the child`,
        { ...plain(index), path: `${nodePath(index)}.session.from` },
      );
    }
    return copy;
  }

  // ---- edges
  const edges: Located<GraphEdgeSpec>[] = [];
  template.edges.forEach((edge, index) => {
    const path = `${frame.path}edges[${index}]`;
    const at = { edgeId: `${frame.id}${edge.id}`, path };
    const badOutput = undeclaredOutput(edge.from);
    if (badOutput !== null) {
      report(
        context,
        "subgraph-port-mismatch",
        `Sub-graph ${(edge.from as GraphPortRef).node} declares no output ${badOutput}`,
        { ...at, path: `${path}.from`, port: badOutput },
      );
      return;
    }
    const from = rewriteSource(edge.from);
    const target = expansions.get(edge.to.node);
    if (!target) {
      edges.push({ value: from === edge.from ? edge : { ...edge, from }, path });
      return;
    }
    if (!declaredInput(target, edge.to.port)) {
      report(
        context,
        "subgraph-port-mismatch",
        `Sub-graph ${edge.to.node} declares no input ${edge.to.port}`,
        { ...at, path: `${path}.to`, port: edge.to.port },
      );
      return;
    }
    const single = (producers.get(`${edge.to.node}.${edge.to.port}`) ?? 0) === 1;
    for (const consumer of consumers(target, edge.to.port)) {
      const inner = consumer.value;
      const transform = [...(edge.transform ?? []), ...(inner.transform ?? [])];
      edges.push({
        value: {
          id: single ? `${edge.to.node}/${inner.id}` : `${edge.to.node}/${inner.id}+${edge.id}`,
          from,
          to: prefixTarget(inner.to, `${edge.to.node}/`),
          ...(transform.length > 0 ? { transform } : {}),
          ...(edge.zip === true || inner.zip === true ? { zip: true } : {}),
        },
        path,
      });
    }
  });
  for (const expansion of expansions.values()) {
    const prefix = `${expansion.node.id}/`;
    for (const entry of expansion.flat.edges) {
      if (isGraphRunInputRef(entry.value.from)) continue;
      edges.push({
        value: {
          ...entry.value,
          id: `${prefix}${entry.value.id}`,
          from: prefixRef(entry.value.from, prefix),
          to: prefixTarget(entry.value.to, prefix),
        },
        path: entry.path,
      });
    }
  }

  // ---- loops
  const loops: Located<GraphLoopRegion>[] = [];
  (template.loops ?? []).forEach((loop, index) => {
    const path = `${frame.path}loops[${index}]`;
    const at = { loopId: `${frame.id}${loop.id}` };
    const carry = loop.carry.flatMap((entry, carryIndex) => {
      const carryPath = `${path}.carry[${carryIndex}]`;
      const badOutput = undeclaredOutput(entry.from);
      if (badOutput !== null) {
        report(
          context,
          "subgraph-port-mismatch",
          `Sub-graph ${entry.from.node} declares no output ${badOutput}`,
          { ...at, path: `${carryPath}.from`, port: badOutput },
        );
        return [];
      }
      const from = rewriteSource(entry.from) as GraphPortRef;
      const target = expansions.get(entry.to.node);
      if (!target) return [{ from, to: entry.to }];
      if (!declaredInput(target, entry.to.port)) {
        report(
          context,
          "subgraph-port-mismatch",
          `Sub-graph ${entry.to.node} declares no input ${entry.to.port}`,
          { ...at, path: `${carryPath}.to`, port: entry.to.port },
        );
        return [];
      }
      return consumers(target, entry.to.port).flatMap((consumer) => {
        if ((consumer.value.transform ?? []).length > 0) {
          report(
            context,
            "subgraph-unsupported",
            `A loop carry into ${entry.to.node}.${entry.to.port} would need the child's edge transforms, and carries have none`,
            { ...at, path: carryPath },
          );
          return [];
        }
        return [{ from, to: prefixTarget(consumer.value.to, `${entry.to.node}/`) }];
      });
    });
    const until = mapPredicateRoots(loop.until, (leaf) => {
      const segments = leaf.split(".");
      const expansion = expansions.get(segments[0]!);
      if (!expansion || segments.length < 2) return leaf;
      const source = declaredOutput(expansion, segments[1]!)
        ? exposed(expansion, segments[1]!)
        : undefined;
      if (!source || source.outlet !== undefined) {
        report(
          context,
          "subgraph-unsupported",
          `Loop ${loop.id} reads ${segments[0]}.${segments[1]}, which ${source ? "a gate forwards inside the sub-graph" : "the sub-graph does not expose"}; a loop condition reads an output port`,
          { ...at, path: `${path}.until` },
        );
        return leaf;
      }
      return [`${source.node}.${source.port}`, ...segments.slice(2)].join(".");
    });
    loops.push({
      value: {
        ...loop,
        nodes: loop.nodes.flatMap((member) => {
          const expansion = expansions.get(member);
          return expansion
            ? expansion.flat.nodes.map((entry) => `${member}/${entry.value.id}`)
            : [member];
        }),
        until,
        carry,
      },
      path,
    });
  });
  for (const expansion of expansions.values()) {
    const prefix = `${expansion.node.id}/`;
    for (const entry of expansion.flat.loops) {
      const loop = entry.value;
      loops.push({
        value: {
          ...loop,
          id: `${prefix}${loop.id}`,
          nodes: loop.nodes.map((member) => `${prefix}${member}`),
          until: prefixPredicate(loop.until, prefix),
          carry: loop.carry.map((carry) => ({
            from: prefixRef(carry.from, prefix),
            to: prefixTarget(carry.to, prefix),
          })),
        },
        path: entry.path,
      });
    }
  }

  // ---- types
  const types: Located<ArtifactTypeDef>[] = (template.types ?? []).map((def, index) => ({
    value: def,
    path: `${frame.path}types[${index}]`,
  }));
  const typeByRef = new Map(types.map((entry) => [typeRef(entry.value), entry.value]));
  for (const expansion of expansions.values()) {
    for (const entry of expansion.flat.types) {
      const ref = typeRef(entry.value);
      const existing = typeByRef.get(ref);
      if (!existing) {
        typeByRef.set(ref, entry.value);
        types.push(entry);
      } else if (canonicalJson(existing) !== canonicalJson(entry.value)) {
        report(
          context,
          "subgraph-type-conflict",
          `${expansion.child.name} defines ${ref} differently from this template; rename one or bump its version`,
          { nodeId: `${frame.id}${expansion.node.id}`, path: entry.path },
        );
      }
    }
  }

  // ---- run outputs
  const outputs = (template.outputs ?? []).map((output, index) => {
    const badOutput = undeclaredOutput(output.from);
    if (badOutput !== null) {
      report(
        context,
        "subgraph-port-mismatch",
        `Sub-graph ${output.from.node} declares no output ${badOutput}`,
        { path: `${frame.path}outputs[${index}].from`, port: badOutput },
      );
      return output;
    }
    const from = rewriteSource(output.from) as GraphPortRef;
    return from === output.from ? output : { ...output, from };
  });

  // ---- instances
  const subgraphs: GraphInlinedSubgraph[] = [];
  const nodeSubgraph = new Map<string, string>();
  const loopSubgraph = new Map<string, string>();
  for (const expansion of expansions.values()) {
    const id = expansion.node.id;
    const prefix = `${id}/`;
    const { child } = expansion;
    subgraphs.push({
      id,
      ...(expansion.node.label !== undefined ? { label: expansion.node.label } : {}),
      template: {
        scope: expansion.node.template.scope,
        id: child.id,
        revision: expansion.revision,
        digest: expansion.digest,
        name: child.name,
        ...(child.engine !== undefined ? { engine: child.engine } : {}),
        ...(expansion.resolvedPath !== undefined ? { path: expansion.resolvedPath } : {}),
      },
      parameters: child.parameters,
      params: expansion.params,
      roles: expansion.roles,
      inputs: Object.fromEntries(
        (expansion.node.inputs ?? []).map((port) => [
          port.name,
          consumers(expansion, port.name).map((entry) => prefixTarget(entry.value.to, prefix)),
        ]),
      ),
      outputs: Object.fromEntries(
        (expansion.node.outputs ?? []).flatMap((port) => {
          const source = exposed(expansion, port.name);
          return source ? [[port.name, source]] : [];
        }),
      ),
    });
    for (const inner of expansion.flat.subgraphs) {
      subgraphs.push({
        ...inner,
        id: `${prefix}${inner.id}`,
        parent: inner.parent !== undefined ? `${prefix}${inner.parent}` : id,
        params: Object.fromEntries(
          Object.entries(inner.params).map(([key, source]) => [
            key,
            "param" in source ? (expansion.params[source.param] ?? source) : source,
          ]),
        ),
        roles: Object.fromEntries(
          Object.entries(inner.roles).map(([key, role]) => [key, mapRole(role, expansion.roles)]),
        ),
        inputs: Object.fromEntries(
          Object.entries(inner.inputs).map(([port, targets]) => [
            port,
            targets.map((target) => prefixTarget(target, prefix)),
          ]),
        ),
        outputs: Object.fromEntries(
          Object.entries(inner.outputs).map(([port, source]) => [port, prefixRef(source, prefix)]),
        ),
      });
    }
    for (const entry of expansion.flat.nodes) {
      const inner = expansion.flat.nodeSubgraph.get(entry.value.id);
      nodeSubgraph.set(`${prefix}${entry.value.id}`, inner ? `${prefix}${inner}` : id);
    }
    for (const entry of expansion.flat.loops) {
      const inner = expansion.flat.loopSubgraph.get(entry.value.id);
      loopSubgraph.set(`${prefix}${entry.value.id}`, inner ? `${prefix}${inner}` : id);
    }
  }
  return { nodes, edges, loops, types, outputs, subgraphs, nodeSubgraph, loopSubgraph };
}

// ---------------------------------------------------------------- entry

const ENTRY_PATH = /^(nodes|edges|loops|types)\[(\d+)\]/;

/**
 * Inline every sub-graph node of a guarded template. Pure: the resolver is
 * called at most once per distinct reference.
 */
export function inlineGraphSubgraphs(
  template: GraphTemplateV1,
  resolve: GraphTemplateResolver | undefined,
): GraphSubgraphInlineResult {
  const untouched: GraphSubgraphInlineResult = {
    template,
    mapPath: null,
    subgraphs: [],
    nodeSubgraph: new Map(),
    loopSubgraph: new Map(),
    diagnostics: [],
  };
  if (!template.nodes.some((node) => node.kind === "subgraph")) return untouched;
  const context: Context = { resolve, cache: new Map(), diagnostics: [], inlined: 0 };
  const flat = flatten(context, template, { path: "", id: "", depth: 0, stack: [] });
  if (
    flat.nodes.length > GRAPH_PLAN_BOUNDS.maxNodes ||
    flat.edges.length > GRAPH_PLAN_BOUNDS.maxEdges ||
    flat.loops.length > GRAPH_PLAN_BOUNDS.maxLoops
  ) {
    return {
      ...untouched,
      diagnostics: [
        ...context.diagnostics,
        {
          code: "subgraph-too-large",
          severity: GRAPH_COMPILE_DIAGNOSTICS["subgraph-too-large"].severity,
          message: `With its sub-graphs inlined the template has ${flat.nodes.length} nodes, ${flat.edges.length} edges and ${flat.loops.length} loops; a plan holds at most ${GRAPH_PLAN_BOUNDS.maxNodes}, ${GRAPH_PLAN_BOUNDS.maxEdges} and ${GRAPH_PLAN_BOUNDS.maxLoops}`,
          path: "nodes",
        },
      ],
    };
  }
  const { layout: _layout, ...rest } = template;
  const flatTemplate: GraphTemplateV1 = {
    ...rest,
    nodes: flat.nodes.map((entry) => entry.value),
    edges: flat.edges.map((entry) => entry.value),
    ...(template.loops !== undefined || flat.loops.length > 0
      ? { loops: flat.loops.map((entry) => entry.value) }
      : {}),
    ...(template.types !== undefined || flat.types.length > 0
      ? { types: flat.types.map((entry) => entry.value) }
      : {}),
    ...(template.outputs !== undefined ? { outputs: flat.outputs } : {}),
  };
  const paths: Record<string, readonly string[]> = {
    nodes: flat.nodes.map((entry) => entry.path),
    edges: flat.edges.map((entry) => entry.path),
    loops: flat.loops.map((entry) => entry.path),
    types: flat.types.map((entry) => entry.path),
  };
  return {
    template: flatTemplate,
    mapPath: (path) => {
      const match = ENTRY_PATH.exec(path);
      if (!match) return path;
      const original = paths[match[1]!]?.[Number(match[2])];
      return original === undefined ? path : `${original}${path.slice(match[0].length)}`;
    },
    subgraphs: flat.subgraphs,
    nodeSubgraph: flat.nodeSubgraph,
    loopSubgraph: flat.loopSubgraph,
    diagnostics: context.diagnostics,
  };
}
