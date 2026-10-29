/**
 * Compiler pass: ports and edges (report §5.7, §5.8, §5.10). Replication
 * branch counts; the type each edge delivers after its transforms; zip
 * edges; assignability and cardinality; required inputs; several producers
 * into one port (allowed on list ports, on mutually exclusive gate outlets,
 * or split by `firstIterationFrom`); collect policies; merge strategies;
 * run output types.
 */
import type { GraphDiagnosticLocation } from "./compile-diagnostics.js";
import { checkGraphFilterPredicate } from "./compile-conditions.js";
import { graphProducersExclusive } from "./compile-graph.js";
import {
  type GraphCompileState,
  type GraphProducer,
  graphSourceLabel,
  portKey,
} from "./compile-state.js";
import { GRAPH_TEMPLATE_BOUNDS } from "./grammar.js";
import type { GraphPlanBranches } from "./plan.js";
import { graphSchemaAtPath, graphSchemaNonNull } from "./schema-subset.js";
import {
  type GraphEdgeSource,
  type GraphMergeNode,
  type GraphReplicateAxis,
  isGraphRunInputRef,
} from "./template-model.js";
import {
  graphEdgeTransformResultType,
  graphTypeAssignability,
  suggestGraphTypeAdapters,
} from "./type-assignability.js";
import { graphListType, type GraphValueType, graphValueTypeLabel } from "./types.js";

const MAX_BRANCHES = GRAPH_TEMPLATE_BOUNDS.maxBranches;

// ---------------------------------------------------------------- branches

function axesOf(state: GraphCompileState, nodeId: string): GraphReplicateAxis[] {
  const node = state.nodes.get(nodeId)?.node;
  if (!node || (node.kind !== "agent" && node.kind !== "subgraph") || !node.replicate) return [];
  return node.replicate.over === "cross" ? node.replicate.axes : [node.replicate];
}

/** The producer of an `items` node's replicated input, for its zip signature. */
function itemsOrigin(state: GraphCompileState, nodeId: string, input: string): string {
  const sources = state
    .producersOf(nodeId, input)
    .map((producer) => graphSourceLabel(producer.from));
  return sources.sort().join("+") || input;
}

/** Branch counts and zip signatures; fan-out wider than 32 is an error. */
export function computeGraphBranches(state: GraphCompileState): void {
  for (const { node, path } of state.nodes.values()) {
    const axes = axesOf(state, node.id);
    if (axes.length === 0) {
      state.branches.set(node.id, { min: 1, max: 1 });
      continue;
    }
    let min = 1;
    let max = 1;
    const signature: string[] = [];
    for (const axis of axes) {
      switch (axis.over) {
        case "panel": {
          const role = state.roles.get(axis.role);
          min *= 1;
          max *= Math.min(role?.maxPanel ?? MAX_BRANCHES, MAX_BRANCHES);
          signature.push(`panel:${axis.role}`);
          break;
        }
        case "lenses":
          min *= axis.lenses.length;
          max *= axis.lenses.length;
          signature.push(`lenses:${axis.lenses.map((lens) => lens.key).join(",")}`);
          break;
        case "items":
          min *= 0;
          max *= axis.maxBranches;
          signature.push(`items:${itemsOrigin(state, node.id, axis.input)}`);
          break;
        case "samples":
          min *= axis.count;
          max *= axis.count;
          signature.push(`samples:${axis.count}`);
          break;
      }
    }
    state.branches.set(node.id, { min, max });
    state.replicateSignatures.set(node.id, signature.join("×"));
    if (max > MAX_BRANCHES) {
      state.diagnostics.add(
        "fanout-too-wide",
        `${node.id} can run ${max} branches; a node runs at most ${MAX_BRANCHES}`,
        { nodeId: node.id, path: `${path}.replicate` },
      );
    }
  }
}

export function graphNodeBranches(state: GraphCompileState, nodeId: string): GraphPlanBranches {
  return state.branches.get(nodeId) ?? { min: 1, max: 1 };
}

// ---------------------------------------------------------------- edge types

/** The type a source produces, lifted to a list for a replicated node unless zipped. */
export function graphSourceType(
  state: GraphCompileState,
  source: GraphEdgeSource,
  zip = false,
): GraphValueType | null {
  if (isGraphRunInputRef(source)) return state.runInputTypes.get(source.input) ?? null;
  if (source.outlet !== undefined) {
    return state.inputTypes.get(portKey(source.node, source.port)) ?? null;
  }
  const type = state.outputTypes.get(portKey(source.node, source.port)) ?? null;
  if (!type) return null;
  return state.isReplicated(source.node) && !zip ? graphListType(type) : type;
}

function reportAssignability(
  state: GraphCompileState,
  delivered: GraphValueType,
  target: GraphValueType,
  what: string,
  at: GraphDiagnosticLocation,
): { ok: boolean; budgetCheck: boolean } {
  const fit = graphTypeAssignability(delivered, target);
  if (fit.ok) return { ok: true, budgetCheck: fit.via === "structural" && fit.budgetCheck };
  if (fit.code === "cardinality") {
    const hint =
      delivered.kind === "list"
        ? "; make the port a list<…> to collect the branches, or zip into a node replicated the same way"
        : "; a single value fans out with replicate, not with an edge";
    state.diagnostics.add("edge-cardinality", `${what}: ${fit.message}${hint}`, {
      ...at,
      detail: fit.code,
    });
    return { ok: false, budgetCheck: false };
  }
  const adapters = suggestGraphTypeAdapters(delivered, target, state.library).map(
    (adapter) => adapter.id,
  );
  state.diagnostics.add(
    "edge-type-mismatch",
    `${what}: ${fit.message}${adapters.length > 0 ? ` (try the adapter ${adapters.join(" or ")})` : ""}`,
    { ...at, detail: fit.code },
  );
  return { ok: false, budgetCheck: false };
}

function checkZip(state: GraphCompileState, producer: GraphProducer): boolean {
  const edge = producer.edge!;
  const at = { edgeId: edge.id, path: `${producer.path}.zip` };
  const from = edge.from;
  if (isGraphRunInputRef(from) || from.outlet !== undefined || !state.isReplicated(from.node)) {
    state.diagnostics.add("edge-zip-invalid", "zip needs a replicated node at the source", at);
    return false;
  }
  if (!state.isReplicated(edge.to.node)) {
    state.diagnostics.add("edge-zip-invalid", "zip needs a replicated node at the target", at);
    return false;
  }
  const items = axesOf(state, edge.to.node).find((axis) => axis.over === "items");
  if (items?.over === "items" && items.input === edge.to.port) {
    state.diagnostics.add(
      "edge-zip-invalid",
      "The input an items node replicates over takes a whole list; it cannot be zipped",
      at,
    );
    return false;
  }
  const source = state.replicateSignatures.get(from.node);
  const target = state.replicateSignatures.get(edge.to.node);
  if (source !== target) {
    state.diagnostics.add(
      "edge-zip-invalid",
      `zip pairs branch k with branch k, so both nodes must replicate the same way (${source} vs ${target})`,
      at,
    );
    return false;
  }
  return true;
}

/** Type every edge: source, transforms (and filter predicates), target. */
export function checkGraphEdgeTypes(state: GraphCompileState): void {
  for (const { edge: listed } of state.edges) {
    {
      const producer = state
        .producersOf(listed.to.node, listed.to.port)
        .find((entry) => entry.kind === "edge" && entry.id === listed.id)!;
      const edge = listed;
      const at = { edgeId: edge.id, path: producer.path };
      const record = (
        source: GraphValueType | null,
        delivered: GraphValueType | null,
        budgetCheck = false,
        fanIn = false,
      ) => {
        state.producerTypes.set(edge.id, { source, delivered, budgetCheck, fanIn });
        if (fanIn) state.fanInPorts.add(portKey(edge.to.node, edge.to.port));
      };
      const zip = edge.zip === true;
      if (zip && !checkZip(state, producer)) {
        record(null, null);
        continue;
      }
      const source = graphSourceType(state, edge.from, zip);
      const fanIn =
        !zip &&
        !isGraphRunInputRef(edge.from) &&
        edge.from.outlet === undefined &&
        state.isReplicated(edge.from.node);
      if (!source) {
        record(null, null, false, fanIn);
        continue;
      }
      let current = source;
      let failed = false;
      (edge.transform ?? []).forEach((transform, index) => {
        if (failed) return;
        const path = `${producer.path}.transform[${index}]`;
        if (transform.op === "filter") {
          checkGraphFilterPredicate(state, transform.where, current, `${path}.where`, {
            edgeId: edge.id,
          });
        }
        const result = graphEdgeTransformResultType(current, transform, state.library);
        if (!result.ok) {
          state.diagnostics.add(
            "edge-transform-invalid",
            `${transform.op} on ${graphValueTypeLabel(current)}: ${result.message}`,
            { edgeId: edge.id, path, detail: result.code },
          );
          failed = true;
          return;
        }
        current = result.type;
      });
      if (failed) {
        record(source, null, false, fanIn);
        continue;
      }
      const target = state.inputTypes.get(portKey(edge.to.node, edge.to.port)) ?? null;
      if (!target) {
        record(source, current, false, fanIn);
        continue;
      }
      const fit = reportAssignability(
        state,
        current,
        target,
        `${graphSourceLabel(edge.from)} → ${edge.to.node}.${edge.to.port}`,
        at,
      );
      record(source, fit.ok ? current : null, fit.budgetCheck, fanIn);
    }
  }
  for (const producer of state.carries) {
    const carry = producer.carry!;
    const source = graphSourceType(state, carry.from);
    const target = state.inputTypes.get(portKey(carry.to.node, carry.to.port)) ?? null;
    let budgetCheck = false;
    let delivered: GraphValueType | null = null;
    if (source && target) {
      const fit = reportAssignability(
        state,
        source,
        target,
        `carry ${graphSourceLabel(carry.from)} → ${carry.to.node}.${carry.to.port}`,
        producer.at,
      );
      budgetCheck = fit.budgetCheck;
      if (fit.ok) delivered = source;
    }
    state.producerTypes.set(producer.id, { source, delivered, budgetCheck, fanIn: false });
  }
}

// ---------------------------------------------------------------- inputs

function mutuallyExclusive(state: GraphCompileState, producers: GraphProducer[]): boolean {
  for (let i = 0; i < producers.length; i++) {
    for (let j = i + 1; j < producers.length; j++) {
      if (!graphProducersExclusive(state, producers[i]!, producers[j]!)) return false;
    }
  }
  return true;
}

/** Required inputs, producer counts, collect policies, delivered types. */
export function checkGraphInputs(state: GraphCompileState): void {
  for (const { node, path } of state.nodes.values()) {
    (node.inputs ?? []).forEach((port, index) => {
      const key = portKey(node.id, port.name);
      const at = { nodeId: node.id, port: port.name, path: `${path}.inputs[${index}]` };
      const producers = state.producersOf(node.id, port.name);
      const declared = state.inputTypes.get(key) ?? null;
      const delivered = producers
        .map((producer) => state.producerTypes.get(producer.id)?.delivered ?? null)
        .filter((type): type is GraphValueType => type !== null);
      const labels = new Set(delivered.map(graphValueTypeLabel));
      state.deliveredTypes.set(
        key,
        delivered.length > 0 && labels.size === 1 && delivered.length === producers.length
          ? delivered[0]!
          : declared,
      );

      if (producers.length === 0) {
        if (port.required !== false) {
          state.diagnostics.add(
            "input-unbound",
            `${node.id}.${port.name} is required but nothing feeds it; add an edge or make it optional`,
            at,
          );
        }
      } else if (producers.length > 1 && declared?.kind !== "list") {
        const first = producers.filter(
          (producer) =>
            producer.kind === "edge" && state.edgeIterations.get(producer.id) === "first",
        );
        const groups =
          first.length > 0
            ? [first, producers.filter((producer) => !first.includes(producer))]
            : [producers];
        if (!groups.every((group) => mutuallyExclusive(state, group))) {
          state.diagnostics.add(
            "input-multiple-producers",
            `${node.id}.${port.name} takes one value but ${producers.map((producer) => producer.id).join(", ")} can all deliver it; route them through different outlets of one gate, use firstIterationFrom for a loop entry, or make the port a list`,
            at,
          );
        }
      }

      const fanIn = state.fanInPorts.has(key);
      if (port.collect && !fanIn) {
        state.diagnostics.add(
          "collect-without-fan-in",
          `${node.id}.${port.name} has a collect policy, but no replicated node feeds it`,
          { ...at, path: `${at.path}.collect` },
        );
      }
      if (fanIn) {
        const needed = Math.max(port.collect?.minSuccessful ?? 1, port.collect?.count ?? 0);
        const available = producers
          .filter((producer) => state.producerTypes.get(producer.id)?.fanIn)
          .reduce(
            (sum, producer) =>
              sum + (producer.sourceNode ? (state.branches.get(producer.sourceNode)?.max ?? 1) : 1),
            0,
          );
        if (needed > available) {
          state.diagnostics.add(
            "collect-unsatisfiable",
            `${node.id}.${port.name} needs ${needed} successful branches, but its producers run at most ${available}`,
            { ...at, path: `${at.path}.collect` },
          );
        }
      }
    });
  }
}

// ---------------------------------------------------------------- items fan-out

/**
 * The port an `items` fan-out replicates over must hold items (item 401): a
 * `list<T>` (one item per element) or a named type that declares `items`
 * (one item per entry of its item list).
 */
export function checkGraphItemsInputs(state: GraphCompileState): void {
  for (const { node, path } of state.nodes.values()) {
    if ((node.kind !== "agent" && node.kind !== "subgraph") || !node.replicate) continue;
    const cross = node.replicate.over === "cross";
    axesOf(state, node.id).forEach((axis, index) => {
      if (axis.over !== "items") return;
      const type = state.inputTypes.get(portKey(node.id, axis.input));
      if (!type || graphItemsInputHoldsItems(type)) return;
      state.diagnostics.add(
        "replicate-items-input",
        `${node.id} replicates over ${axis.input}, which is ${graphValueTypeLabel(type)}; make it list<T> or a type that declares items`,
        {
          nodeId: node.id,
          port: axis.input,
          path: cross ? `${path}.replicate.axes[${index}].input` : `${path}.replicate.input`,
        },
      );
    });
  }
}

/** Whether a port type holds items an `items` fan-out can replicate over. */
export function graphItemsInputHoldsItems(type: GraphValueType): boolean {
  if (type.kind === "list") return type.element.kind !== "list";
  return type.kind === "named" && type.definition.items !== undefined;
}

// ---------------------------------------------------------------- merges

function elementSchema(type: GraphValueType): Record<string, unknown> | null {
  if (type.kind === "named") return type.definition.schema;
  if (type.kind === "shape") return type.schema;
  return null;
}

function itemSchema(type: GraphValueType): Record<string, unknown> | null {
  if (type.kind !== "named" || !type.definition.items) return null;
  const field = graphSchemaAtPath(type.definition.schema, type.definition.items.path);
  const items = field ? graphSchemaNonNull(field.schema).schema.items : undefined;
  return items && typeof items === "object" ? (items as Record<string, unknown>) : null;
}

function schemaTypeAt(schema: Record<string, unknown>, path: string): string | undefined | null {
  const field = graphSchemaAtPath(schema, path);
  if (!field) return null;
  const inner = graphSchemaNonNull(field.schema).schema;
  return typeof inner.type === "string" ? inner.type : undefined;
}

function checkMerge(state: GraphCompileState, node: GraphMergeNode, path: string): void {
  const invalid = (message: string, detail: string, at = `${path}.strategy`) =>
    state.diagnostics.add("merge-invalid", message, { nodeId: node.id, path: at, detail });
  const inputs = node.inputs ?? [];
  const outputs = node.outputs ?? [];
  if (inputs.length !== 1) {
    invalid(
      `A merge node reads exactly one list<…> input; ${node.id} has ${inputs.length}`,
      "inputs",
      `${path}.inputs`,
    );
    return;
  }
  if (outputs.length !== 1) {
    invalid(
      `A merge node has exactly one output; ${node.id} has ${outputs.length}`,
      "outputs",
      `${path}.outputs`,
    );
    return;
  }
  const input = state.deliveredTypes.get(portKey(node.id, inputs[0]!.name)) ?? null;
  const output = state.outputTypes.get(portKey(node.id, outputs[0]!.name)) ?? null;
  if (!input || !output) return;
  if (input.kind !== "list") {
    invalid(
      `A merge node reads a list; ${inputs[0]!.name} is ${graphValueTypeLabel(input)}`,
      "not_a_list",
      `${path}.inputs[0]`,
    );
    return;
  }
  const element = input.element;
  const expected = node.strategy.kind === "collect" ? input : element;
  if (!graphTypeAssignability(expected, output).ok) {
    invalid(
      `The ${node.strategy.kind} merge produces ${graphValueTypeLabel(expected)}, which does not fit ${graphValueTypeLabel(output)}`,
      "output_type",
      `${path}.outputs[0]`,
    );
  }
  const strategy = node.strategy;
  switch (strategy.kind) {
    case "concat":
    case "dedupe": {
      const items = itemSchema(element);
      if (!items) {
        invalid(
          `${strategy.kind} merges the item lists of ${graphValueTypeLabel(element)}, which declares no items`,
          "no_items",
        );
        return;
      }
      if (strategy.kind === "dedupe") {
        strategy.key.forEach((key, index) => {
          if (schemaTypeAt(items, key) === null) {
            invalid(
              `The items of ${graphValueTypeLabel(element)} have no field ${key}`,
              "unknown_path",
              `${path}.strategy.key[${index}]`,
            );
          }
        });
      }
      return;
    }
    case "vote": {
      const schema = elementSchema(element);
      const field = strategy.path ?? "choice";
      const type = schema ? schemaTypeAt(schema, field) : null;
      if (type !== "string") {
        invalid(
          `vote counts a text field; ${graphValueTypeLabel(element)}.${field} is not one`,
          "vote_path",
        );
      }
      return;
    }
    case "best": {
      const schema = elementSchema(element);
      const type = schema ? schemaTypeAt(schema, strategy.score) : null;
      if (type !== "number" && type !== "integer") {
        invalid(
          `best compares a number; ${graphValueTypeLabel(element)}.${strategy.score} is not one`,
          "score_path",
          `${path}.strategy.score`,
        );
      }
      return;
    }
    case "collect":
      return;
  }
}

export function checkGraphMerges(state: GraphCompileState): void {
  for (const { node, path } of state.nodes.values()) {
    if (node.kind === "merge") checkMerge(state, node, path);
  }
}

// ---------------------------------------------------------------- run outputs

export function checkGraphRunOutputs(state: GraphCompileState): void {
  (state.template.outputs ?? []).forEach((output, index) => {
    if (!state.nodes.has(output.from.node)) return;
    const source = graphSourceType(state, output.from);
    const declared = state.library.resolve(output.type);
    if (!source || !declared.ok) return;
    const fit = graphTypeAssignability(source, declared.type);
    if (!fit.ok) {
      state.diagnostics.add("output-type-mismatch", `Run output ${output.name}: ${fit.message}`, {
        path: `outputs[${index}]`,
        detail: fit.code,
      });
    }
  });
}
