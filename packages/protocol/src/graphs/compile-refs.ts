/**
 * Compiler pass 1: the template guard's errors, custom types, type
 * resolution and every cross-reference the guard leaves to the compiler
 * (item 101's Notes): edge and carry endpoints, outlets, roles, loop
 * members, run outputs, the `error` port, and `items` replication (item 401).
 * Sub-graphs are inlined before this pass (compile-subgraphs, item 402).
 */
import { canonicalJson } from "../canonical-json.js";
import { FieldErrorCollector, type FieldError } from "../field-validation.js";
import { WORKFLOW_RESULT_KINDS } from "../workflow-results.js";
import { checkArtifactTypeDef } from "./artifact-type-def.js";
import type { GraphCompileDiagnostics, GraphDiagnosticLocation } from "./compile-diagnostics.js";
import { type GraphCompileState, portKey } from "./compile-state.js";
import {
  type GraphEdgeSource,
  type GraphNodeSpec,
  type GraphPortTarget,
  type GraphReplicateAxis,
  graphHumanRoutesFailures,
  graphNodeOutlets,
  isGraphRunInputRef,
} from "./template-model.js";

// ---------------------------------------------------------------- guard

const ENTRY_PATH = /^(nodes|edges|loops)\[(\d+)\]/;

/** Pin a template path to the node, edge or loop it lies under. */
export function graphPathLocation(template: unknown, path: string): GraphDiagnosticLocation {
  const at: GraphDiagnosticLocation = { path };
  const match = ENTRY_PATH.exec(path);
  if (!match || typeof template !== "object" || template === null) return at;
  const list = (template as Record<string, unknown>)[match[1]!];
  const entry = Array.isArray(list) ? list[Number(match[2])] : undefined;
  const id =
    typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
  if (typeof id !== "string") return at;
  if (match[1] === "nodes") at.nodeId = id;
  else if (match[1] === "edges") at.edgeId = id;
  else at.loopId = id;
  return at;
}

const LOOP_BOUND_PATH = /^loops\[\d+\]\.maxIterations$/;

/**
 * Guard errors as diagnostics. A loop's missing or oversized bound gets its
 * own code (report §7.4); errors in a custom type are `type-invalid`; the
 * rest are `template-invalid`, with the guard's code as `detail`.
 */
export function addGraphGuardDiagnostics(
  template: unknown,
  errors: readonly FieldError[],
  omitted: number,
  diagnostics: GraphCompileDiagnostics,
): void {
  for (const error of errors) {
    const at = { ...graphPathLocation(template, error.path), detail: error.code };
    if (LOOP_BOUND_PATH.test(error.path)) {
      if (error.code === "out_of_range") {
        diagnostics.add(
          "loop-bound-exceeded",
          "A loop runs at most 10 iterations (the Build Pipeline's protocol maximum)",
          at,
        );
        continue;
      }
      if (error.code === "required" || error.code === "type" || error.code === "not_integer") {
        diagnostics.add(
          "loop-unbounded",
          "Every loop needs a whole-number maxIterations between 1 and 10",
          at,
        );
        continue;
      }
    }
    if (error.path.startsWith("types[")) {
      diagnostics.add("type-invalid", error.message, at);
      continue;
    }
    diagnostics.add("template-invalid", error.message, at);
  }
  if (omitted > 0) {
    diagnostics.add("template-invalid", `${omitted} more schema errors were not listed`, {
      path: "$",
    });
  }
}

// ---------------------------------------------------------------- types

/** Library types from the options: guarded, and identical to the template's when shared. */
export function checkGraphLibraryTypes(state: GraphCompileState): void {
  const own = new Map(
    (state.template.types ?? []).map((def) => [`${def.name}@${def.version}`, def]),
  );
  state.options.types.forEach((def, index) => {
    const path = `$types[${index}]`;
    const errors = new FieldErrorCollector(20);
    checkArtifactTypeDef(def, path, errors);
    for (const error of errors.errors) {
      state.diagnostics.add("type-invalid", error.message, {
        path: error.path,
        detail: error.code,
      });
    }
    if (errors.failed) return;
    const ref = `${def.name}@${def.version}`;
    const mine = own.get(ref);
    if (mine && canonicalJson(mine) !== canonicalJson(def)) {
      state.diagnostics.add(
        "type-conflict",
        `${ref} is defined differently by the template and by the type library; rename one or bump its version`,
        { path },
      );
    }
  });
}

/** Resolve every port and run input or output type. */
export function resolveGraphPortTypes(state: GraphCompileState): void {
  const resolve = (ref: string, at: GraphDiagnosticLocation) => {
    const result = state.library.resolve(ref);
    if (result.ok) return result.type;
    state.diagnostics.add("type-unresolved", result.message, { ...at, detail: result.code });
    return null;
  };
  state.template.inputs.forEach((spec, index) => {
    state.runInputTypes.set(spec.name, resolve(spec.type, { path: `inputs[${index}].type` }));
  });
  (state.template.outputs ?? []).forEach((spec, index) => {
    resolve(spec.type, { path: `outputs[${index}].type` });
  });
  for (const { node, path } of state.nodes.values()) {
    (node.inputs ?? []).forEach((port, index) => {
      state.inputTypes.set(
        portKey(node.id, port.name),
        resolve(port.type, {
          nodeId: node.id,
          port: port.name,
          path: `${path}.inputs[${index}].type`,
        }),
      );
    });
    if (graphHumanRoutesFailures(node)) {
      // A human node's failures (a timeout) route to its implicit `error` port.
      state.outputTypes.set(
        portKey(node.id, "error"),
        resolve("error@1", { nodeId: node.id, port: "error", path: `${path}.onFailure` }),
      );
    }
    if (!("outputs" in node)) continue;
    (node.outputs ?? []).forEach((port, index) => {
      state.outputTypes.set(
        portKey(node.id, port.name),
        resolve(port.type, {
          nodeId: node.id,
          port: port.name,
          path: `${path}.outputs[${index}].type`,
        }),
      );
    });
  }
}

// ---------------------------------------------------------------- endpoints

function inputNames(node: GraphNodeSpec): string[] {
  return (node.inputs ?? []).map((port) => port.name);
}

function outputNames(node: GraphNodeSpec): string[] {
  return "outputs" in node ? (node.outputs ?? []).map((port) => port.name) : [];
}

/**
 * Check the producing end of an edge, carry or run output. Gates and human
 * nodes produce through an outlet that forwards one of their inputs; other
 * nodes through an output port.
 */
export function checkGraphSource(
  state: GraphCompileState,
  source: GraphEdgeSource,
  at: GraphDiagnosticLocation & { path: string },
  allowRunInput: boolean,
): boolean {
  const { diagnostics } = state;
  if (isGraphRunInputRef(source)) {
    if (allowRunInput && state.runInputs.has(source.input)) return true;
    diagnostics.add("unknown-input", `There is no run input named ${source.input}`, at);
    return false;
  }
  const entry = state.nodes.get(source.node);
  if (!entry) {
    diagnostics.add("unknown-node", `There is no node ${source.node}`, at);
    return false;
  }
  const outlets = graphNodeOutlets(entry.node);
  if (outlets) {
    if (
      source.outlet === undefined &&
      source.port === "error" &&
      graphHumanRoutesFailures(entry.node)
    ) {
      // A human node's routed failure (a timeout): `error@1`, outside its outlets.
      return true;
    }
    if (source.outlet === undefined) {
      diagnostics.add(
        "outlet-required",
        `${source.node} is a ${entry.node.kind} node: read one of its outlets (${outlets.join(", ")})`,
        at,
      );
      return false;
    }
    if (!outlets.includes(source.outlet)) {
      diagnostics.add(
        "unknown-outlet",
        `${source.node} has no outlet ${source.outlet} (it has ${outlets.join(", ")})`,
        at,
      );
      return false;
    }
    if (!inputNames(entry.node).includes(source.port)) {
      diagnostics.add(
        "unknown-port",
        `An outlet forwards the node's inputs; ${source.node} has no input ${source.port}`,
        { ...at, port: source.port },
      );
      return false;
    }
    return true;
  }
  if (source.outlet !== undefined) {
    diagnostics.add(
      "outlet-not-applicable",
      `${source.node} is ${entry.node.kind === "agent" ? "an" : "a"} ${entry.node.kind} node, which has no outlets; only gate and human nodes do`,
      at,
    );
    return false;
  }
  if (!outputNames(entry.node).includes(source.port)) {
    diagnostics.add("unknown-port", `${source.node} has no output port ${source.port}`, {
      ...at,
      port: source.port,
    });
    return false;
  }
  return true;
}

function checkTarget(
  state: GraphCompileState,
  target: GraphPortTarget,
  at: GraphDiagnosticLocation & { path: string },
): boolean {
  const entry = state.nodes.get(target.node);
  if (!entry) {
    state.diagnostics.add("unknown-node", `There is no node ${target.node}`, at);
    return false;
  }
  if (!inputNames(entry.node).includes(target.port)) {
    state.diagnostics.add("unknown-port", `${target.node} has no input port ${target.port}`, {
      ...at,
      port: target.port,
    });
    return false;
  }
  return true;
}

/** Edges, loops and carries, run outputs: register what resolves. */
export function checkGraphReferences(state: GraphCompileState): void {
  const { template, diagnostics } = state;
  template.edges.forEach((edge, index) => {
    const path = `edges[${index}]`;
    const fromOk = checkGraphSource(
      state,
      edge.from,
      { edgeId: edge.id, path: `${path}.from` },
      true,
    );
    const toOk = checkTarget(state, edge.to, { edgeId: edge.id, path: `${path}.to` });
    if (!fromOk || !toOk) return;
    state.edges.push({ edge, index });
    state.addProducer(edge.to.node, edge.to.port, {
      kind: "edge",
      id: edge.id,
      from: edge.from,
      ...(isGraphRunInputRef(edge.from) ? {} : { sourceNode: edge.from.node }),
      edge,
      path,
      at: { edgeId: edge.id, path },
    });
  });

  for (const { loop, index } of state.loops.values()) {
    const path = `loops[${index}]`;
    loop.nodes.forEach((member, memberIndex) => {
      const at = { loopId: loop.id, path: `${path}.nodes[${memberIndex}]` };
      if (!state.nodes.has(member)) {
        diagnostics.add("unknown-node", `Loop ${loop.id} lists ${member}, which does not exist`, {
          ...at,
          nodeId: member,
        });
        return;
      }
      const other = state.loopOf.get(member);
      if (other !== undefined && other !== loop.id) {
        diagnostics.add(
          "loop-overlap",
          `${member} is in loops ${other} and ${loop.id}; a node belongs to at most one loop`,
          { ...at, nodeId: member },
        );
        return;
      }
      state.loopOf.set(member, loop.id);
    });
  }
  for (const { loop, index } of state.loops.values()) {
    loop.carry.forEach((carry, carryIndex) => {
      const path = `loops[${index}].carry[${carryIndex}]`;
      const at = { loopId: loop.id, path };
      const fromOk = checkGraphSource(state, carry.from, { ...at, path: `${path}.from` }, false);
      const toOk = checkTarget(state, carry.to, { ...at, path: `${path}.to` });
      if (!fromOk || !toOk) return;
      const outside = [carry.from.node, carry.to.node].filter(
        (node) => state.loopOf.get(node) !== loop.id,
      );
      if (outside.length > 0) {
        diagnostics.add(
          "loop-carry-outside",
          `A carry of loop ${loop.id} must join two of its members; ${outside.join(" and ")} ${outside.length > 1 ? "are" : "is"} not`,
          at,
        );
        return;
      }
      const producer = {
        kind: "carry" as const,
        id: `${loop.id}#${carryIndex}`,
        from: carry.from,
        sourceNode: carry.from.node,
        carry,
        loopId: loop.id,
        path,
        at,
      };
      state.carries.push(producer);
      state.addProducer(carry.to.node, carry.to.port, producer);
    });
  }

  (template.outputs ?? []).forEach((output, index) => {
    checkGraphSource(state, output.from, { path: `outputs[${index}].from` }, false);
  });
}

// ---------------------------------------------------------------- roles

function axesOf(node: GraphNodeSpec): GraphReplicateAxis[] {
  if ((node.kind !== "agent" && node.kind !== "subgraph") || !node.replicate) return [];
  return node.replicate.over === "cross" ? node.replicate.axes : [node.replicate];
}

/** Role keys exist, and panel roles are used for panel replication only. */
export function checkGraphRoles(state: GraphCompileState): void {
  const { diagnostics } = state;
  const known = (role: string, at: GraphDiagnosticLocation): boolean => {
    if (state.roles.has(role)) return true;
    diagnostics.add("unknown-role", `There is no role ${role}`, at);
    return false;
  };
  for (const { node, path } of state.nodes.values()) {
    const axes = axesOf(node);
    const replicatePath = (axis: number) =>
      node.kind !== "agent" && node.kind !== "subgraph"
        ? path
        : node.replicate?.over === "cross"
          ? `${path}.replicate.axes[${axis}]`
          : `${path}.replicate`;
    axes.forEach((axis, axisIndex) => {
      const at = { nodeId: node.id, path: replicatePath(axisIndex) };
      if (axis.over === "panel") {
        if (known(axis.role, { ...at, path: `${at.path}.role` })) {
          const role = state.roles.get(axis.role)!;
          if (role.multiplicity !== "panel") {
            diagnostics.add(
              "role-multiplicity",
              `Panel replication needs a panel role; ${axis.role} binds one model`,
              { ...at, path: `${at.path}.role` },
            );
          }
        }
      } else if (axis.over === "lenses") {
        axis.lenses.forEach((lens, lensIndex) => {
          if (lens.role !== undefined) {
            known(lens.role, { ...at, path: `${at.path}.lenses[${lensIndex}].role` });
          }
        });
      }
    });
    if (node.kind === "agent" && known(node.role, { nodeId: node.id, path: `${path}.role` })) {
      const role = state.roles.get(node.role)!;
      const panelAxis = axes.some((axis) => axis.over === "panel" && axis.role === node.role);
      if (role.multiplicity === "panel" && !panelAxis) {
        diagnostics.add(
          "role-multiplicity",
          `${node.role} is a panel role: replicate over it ({ over: "panel", role: "${node.role}" }) or use a single-model role`,
          { nodeId: node.id, path: `${path}.role` },
        );
      }
    }
    if (node.kind === "subgraph") {
      for (const [inner, outer] of Object.entries(node.roles ?? {})) {
        known(outer, { nodeId: node.id, path: `${path}.roles.${inner}` });
      }
    }
  }
}

// ---------------------------------------------------------------- node rules

/**
 * Output port names an agent node may not use: each port becomes the MCP
 * tools `submit_<port>` and `validate_<port>` (item 103), which must not
 * collide with the generic `submit_workflow_result` or with a built-in
 * result kind's own tool (`submit_review_report`, …).
 */
export const GRAPH_RESERVED_OUTPUT_PORT_NAMES: readonly string[] = Object.freeze([
  "workflow_result",
  ...WORKFLOW_RESULT_KINDS.map((kind) => kind.replaceAll("-", "_")),
]);

export function isGraphReservedOutputPortName(name: string): boolean {
  return GRAPH_RESERVED_OUTPUT_PORT_NAMES.includes(name);
}

/** `replicate: items` (until item 401), agent output names and the `error` port. */
export function checkGraphNodeRules(state: GraphCompileState): void {
  const { diagnostics } = state;
  for (const { node, path } of state.nodes.values()) {
    axesOf(node).forEach((axis, axisIndex) => {
      if (axis.over !== "items") return;
      const cross = "replicate" in node && node.replicate?.over === "cross";
      diagnostics.add(
        "replicate-items-unsupported",
        "Replication over list items is not yet supported (Phase 4, item 401); use panel, lenses or samples",
        {
          nodeId: node.id,
          path: cross ? `${path}.replicate.axes[${axisIndex}]` : `${path}.replicate`,
        },
      );
    });
    if (!("outputs" in node)) {
      if (node.kind === "human") continue; // its `error` port is implicit
      if ("onFailure" in node && node.onFailure === "route") {
        diagnostics.add(
          "route-without-error-port",
          `A ${node.kind} node has no output ports, so it cannot route failures; use fail-run or skip`,
          { nodeId: node.id, path: `${path}.onFailure` },
        );
      }
      continue;
    }
    const outputs = node.outputs ?? [];
    if (node.kind === "agent") {
      outputs.forEach((port, index) => {
        const at = { nodeId: node.id, port: port.name, path: `${path}.outputs[${index}]` };
        if (port.type.startsWith("list<")) {
          state.diagnostics.add(
            "output-port-list",
            `${node.id}.${port.name} is ${port.type}; an agent submits one value per port, so declare the element type (replication makes the output a list)`,
            { ...at, path: `${at.path}.type` },
          );
        }
        if (isGraphReservedOutputPortName(port.name)) {
          state.diagnostics.add(
            "output-port-reserved",
            `submit_${port.name} is an existing result tool; rename the port`,
            { ...at, path: `${at.path}.name` },
          );
        }
      });
    }
    const errorIndex = outputs.findIndex((port) => port.name === "error");
    const errorPort = outputs[errorIndex];
    if (errorPort && errorPort.type !== "error@1") {
      diagnostics.add("error-port-type", `The error port carries error@1, not ${errorPort.type}`, {
        nodeId: node.id,
        port: "error",
        path: `${path}.outputs[${errorIndex}].type`,
      });
    }
    if (node.onFailure === "route" && errorPort?.type !== "error@1") {
      diagnostics.add(
        "route-without-error-port",
        'onFailure "route" emits error@1 on an output port named error; declare { name: "error", type: "error@1" }',
        { nodeId: node.id, path: `${path}.onFailure` },
      );
    }
  }
}
