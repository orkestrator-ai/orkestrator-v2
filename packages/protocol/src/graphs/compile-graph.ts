/**
 * Compiler pass 2: topology. Cycles, topological order and reachability;
 * loop regions (contiguity, entries, members that only run from iteration
 * 2); the `firstIterationFrom` port option (report §9.2); the gate and human
 * outlets each node depends on, which decide mutual exclusivity (§5.10); and
 * the "may run at the same time" relation the workspace rules (§6.7) and the
 * cost estimate use.
 */
import { compareStrings } from "./plan.js";
import { type GraphCompileState, type GraphProducer, graphSourceLabel } from "./compile-state.js";
import { type GraphEdgeSource, graphNodeOutlets, isGraphRunInputRef } from "./template-model.js";

// ---------------------------------------------------------------- order

function sameSource(a: GraphEdgeSource, b: GraphEdgeSource): boolean {
  if (isGraphRunInputRef(a) || isGraphRunInputRef(b)) {
    return isGraphRunInputRef(a) && isGraphRunInputRef(b) && a.input === b.input;
  }
  return a.node === b.node && a.port === b.port && a.outlet === b.outlet;
}

/** Strongly connected components of the remaining nodes (Tarjan, iterative). */
function cycles(nodes: string[], successors: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: string[] }> = [];
    const open = (node: string) => {
      index.set(node, counter);
      low.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
      work.push({
        node,
        next: [...(successors.get(node) ?? [])].filter((n) => nodes.includes(n)).sort(),
      });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const child = frame.next.shift();
      if (child !== undefined) {
        if (!index.has(child)) open(child);
        else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        const selfLoop = successors.get(frame.node)?.has(frame.node) ?? false;
        if (component.length > 1 || selfLoop) components.push(component.sort());
      }
    }
  }
  return components;
}

/** Topological order (ties by id) and reachability; cycles are errors. */
export function computeGraphTopology(state: GraphCompileState): void {
  const ids = [...state.nodes.keys()];
  const successors = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const { edge } of state.edges) {
    if (isGraphRunInputRef(edge.from)) continue;
    const next = successors.get(edge.from.node)!;
    if (next.has(edge.to.node)) continue;
    next.add(edge.to.node);
    indegree.set(edge.to.node, indegree.get(edge.to.node)! + 1);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(compareStrings);
    const node = ready.shift()!;
    order.push(node);
    for (const next of successors.get(node)!) {
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (order.length < ids.length) {
    const remaining = ids.filter((id) => !order.includes(id));
    for (const component of cycles(remaining, successors)) {
      const loops = new Set(component.map((node) => state.loopOf.get(node)));
      const loop = loops.size === 1 ? [...loops][0] : undefined;
      state.diagnostics.add(
        "graph-cycle",
        loop === undefined
          ? `Edges form a cycle through ${component.join(", ")}; put the nodes in a loop and pass values to the next iteration with carry`
          : `Edges form a cycle inside loop ${loop} (${component.join(", ")}); values reach the next iteration only through the loop's carry`,
        state.nodeAt(component[0]!),
      );
    }
    return;
  }
  state.order = order;
  for (const node of [...order].reverse()) {
    const reach = new Set<string>();
    for (const next of successors.get(node)!) {
      reach.add(next);
      for (const further of state.descendants.get(next) ?? []) reach.add(further);
    }
    state.descendants.set(node, reach);
  }
}

// ---------------------------------------------------------------- loops

function membersOf(state: GraphCompileState, loopId: string): string[] {
  const members = [...state.loopOf].filter(([, loop]) => loop === loopId).map(([node]) => node);
  const order = state.order;
  return order
    ? members.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    : members.sort(compareStrings);
}

export function graphLoopMembers(state: GraphCompileState, loopId: string): string[] {
  return membersOf(state, loopId);
}

/** Members no other member feeds over an edge. */
export function graphLoopEntries(state: GraphCompileState, loopId: string): string[] {
  const members = new Set(membersOf(state, loopId));
  return [...members].filter(
    (member) =>
      !state.edges.some(
        ({ edge }) =>
          edge.to.node === member && !isGraphRunInputRef(edge.from) && members.has(edge.from.node),
      ),
  );
}

/** A region is contiguous: no path leaves it and comes back. */
export function checkGraphLoopRegions(state: GraphCompileState): void {
  if (!state.order) return;
  for (const { loop, index } of state.loops.values()) {
    const members = membersOf(state, loop.id);
    const memberSet = new Set(members);
    const escapes = state.order.filter(
      (node) =>
        !memberSet.has(node) &&
        members.some((member) => state.reaches(member, node)) &&
        members.some((member) => state.reaches(node, member)),
    );
    if (escapes.length > 0) {
      state.diagnostics.add(
        "loop-not-contiguous",
        `Paths leave loop ${loop.id} and re-enter it through ${escapes.join(", ")}; add ${escapes.length > 1 ? "them" : "it"} to the loop or rewire`,
        { loopId: loop.id, path: `loops[${index}].nodes` },
      );
    }
  }
}

// ---------------------------------------------------------------- iterations

/**
 * `firstIterationFrom` (report §9.2): on a loop member's input, the edge from
 * that source (outside the loop) feeds iteration 1 and the port's other
 * producers (inside edges or carries) feed later iterations. Every other
 * edge delivers on every iteration.
 */
export function checkGraphFirstIteration(state: GraphCompileState): void {
  for (const { edge } of state.edges) state.edgeIterations.set(edge.id, "all");
  for (const { node, path } of state.nodes.values()) {
    (node.inputs ?? []).forEach((port, portIndex) => {
      const first = port.firstIterationFrom;
      if (first === undefined) return;
      const at = {
        nodeId: node.id,
        port: port.name,
        path: `${path}.inputs[${portIndex}].firstIterationFrom`,
      };
      const invalid = (detail: string, message: string) =>
        state.diagnostics.add("first-iteration-invalid", message, { ...at, detail });
      const loop = state.loopOf.get(node.id);
      if (loop === undefined) {
        invalid("not_in_loop", `${node.id} is in no loop, so it has no first iteration`);
        return;
      }
      const producers = state.producersOf(node.id, port.name);
      const matched = producers.filter(
        (producer) => producer.kind === "edge" && sameSource(producer.from, first),
      );
      if (matched.length === 0) {
        invalid(
          "no_edge",
          `firstIterationFrom names ${graphSourceLabel(first)}, but no edge from it feeds ${node.id}.${port.name}`,
        );
        return;
      }
      if (!isGraphRunInputRef(first) && state.loopOf.get(first.node) === loop) {
        invalid(
          "inside_loop",
          `${first.node} is inside loop ${loop}; the first iteration's value must come from outside the loop`,
        );
        return;
      }
      const later = producers.filter((producer) => !matched.includes(producer));
      if (later.length === 0) {
        invalid(
          "no_later_source",
          `${node.id}.${port.name} has no other producer for iterations after the first; add an edge from inside the loop or a carry`,
        );
        return;
      }
      for (const producer of matched) state.edgeIterations.set(producer.id, "first");
      for (const producer of later) {
        if (producer.kind === "edge") state.edgeIterations.set(producer.id, "later");
      }
    });
  }
}

/** Whether a producer delivers on a loop's first iteration. */
function deliversFirst(state: GraphCompileState, producer: GraphProducer): boolean {
  return producer.kind === "edge" && state.edgeIterations.get(producer.id) !== "later";
}

/**
 * Loop members that cannot run on iteration 1: a required input has no
 * producer then (only carries or later-only edges, or a member that itself
 * runs only later).
 */
export function computeGraphLaterOnly(state: GraphCompileState): void {
  if (!state.order) return;
  for (const nodeId of state.order) {
    const loop = state.loopOf.get(nodeId);
    if (loop === undefined) continue;
    const node = state.nodes.get(nodeId)!.node;
    const runnable = (node.inputs ?? [])
      .filter((port) => port.required !== false)
      .every((port) =>
        state
          .producersOf(nodeId, port.name)
          .some(
            (producer) =>
              deliversFirst(state, producer) &&
              (producer.sourceNode === undefined || !state.laterOnly.has(producer.sourceNode)),
          ),
      );
    if (!runnable) state.laterOnly.add(nodeId);
  }
}

// ---------------------------------------------------------------- conditions

const outletLiteral = (node: string, outlet: string) => `${node}:${outlet}`;

/** The outlets a producer needs taken. */
function sourceConditions(state: GraphCompileState, source: GraphEdgeSource): Set<string> {
  if (isGraphRunInputRef(source)) return new Set();
  const base = state.conditions.get(source.node) ?? new Set<string>();
  if (source.outlet === undefined) return base;
  return new Set([...base, outletLiteral(source.node, source.outlet)]);
}

/**
 * For each node, the gate and human outlets that must be taken for it to
 * run: the union over its required inputs of what every producer of that
 * input needs (a port with several producers needs only what they share).
 */
export function computeGraphConditions(state: GraphCompileState): void {
  if (!state.order) return;
  for (const nodeId of state.order) {
    const node = state.nodes.get(nodeId)!.node;
    const conditions = new Set<string>();
    for (const port of node.inputs ?? []) {
      if (port.required === false) continue;
      const sets = state
        .producersOf(nodeId, port.name)
        .filter((producer) => producer.kind === "edge")
        .map((producer) => sourceConditions(state, producer.from));
      if (sets.length === 0) continue;
      for (const literal of sets[0]!) {
        if (sets.every((set) => set.has(literal))) conditions.add(literal);
      }
    }
    state.conditions.set(nodeId, conditions);
  }
}

/** Two condition sets need different outlets of one gate or human node. */
export function graphConditionsExclusive(a: Set<string>, b: Set<string>): boolean {
  for (const literal of a) {
    const split = literal.lastIndexOf(":");
    const node = literal.slice(0, split);
    for (const other of b) {
      if (other !== literal && other.slice(0, other.lastIndexOf(":")) === node) return true;
    }
  }
  return false;
}

/** Whether two producers can never both deliver in one iteration. */
export function graphProducersExclusive(
  state: GraphCompileState,
  a: GraphProducer,
  b: GraphProducer,
): boolean {
  return graphConditionsExclusive(sourceConditions(state, a.from), sourceConditions(state, b.from));
}

/**
 * Whether the producers of one port, though each may be absent, together
 * cover every outlet of a gate that always takes one (it has `otherwise`)
 * or of a human node: the port is then delivered whenever that node runs
 * (report §9.2: Verify's commit comes from Address or from the clean outlet).
 */
function coversEveryOutlet(state: GraphCompileState, producers: GraphProducer[]): boolean {
  const candidates = new Set<string>();
  for (const producer of producers) {
    for (const literal of sourceConditions(state, producer.from)) {
      candidates.add(literal.slice(0, literal.lastIndexOf(":")));
    }
  }
  for (const gateId of candidates) {
    const gate = state.nodes.get(gateId)?.node;
    if (!gate || state.skippable.has(gateId)) continue;
    if (gate.kind === "gate" && gate.otherwise === undefined) continue;
    const outlets = graphNodeOutlets(gate);
    if (!outlets) continue;
    const base = state.conditions.get(gateId) ?? new Set<string>();
    const covered = new Set<string>();
    for (const producer of producers) {
      const from = producer.from;
      if (isGraphRunInputRef(from)) continue;
      const conditions = sourceConditions(state, from);
      const own = [...conditions].filter((literal) => !base.has(literal));
      const outlet = own.length === 1 ? own[0]! : undefined;
      if (outlet === undefined || !outlet.startsWith(`${gateId}:`)) continue;
      const source = state.nodes.get(from.node)?.node;
      if (from.outlet === undefined && source?.when !== undefined) continue;
      covered.add(outlet.slice(gateId.length + 1));
    }
    if (outlets.every((outlet) => covered.has(outlet))) return true;
  }
  return false;
}

/**
 * Nodes some run can skip: a `when`, an outlet that may not be taken, or a
 * required input whose every producer may be absent (unless together they
 * cover every outlet of one gate). Later-only loop members are handled by
 * the cost estimate.
 */
export function computeGraphSkippable(state: GraphCompileState): void {
  if (!state.order) return;
  for (const nodeId of state.order) {
    const node = state.nodes.get(nodeId)!.node;
    let skippable = node.when !== undefined;
    if (!skippable) {
      skippable = (node.inputs ?? []).some((port) => {
        if (port.required === false) return false;
        const producers = state.producersOf(nodeId, port.name).filter((p) => p.kind === "edge");
        return (
          producers.length > 0 &&
          producers.every((producer) => {
            const from = producer.from;
            if (isGraphRunInputRef(from)) {
              return state.runInputs.get(from.input)?.spec.required === false;
            }
            return from.outlet !== undefined || state.skippable.has(from.node);
          }) &&
          !coversEveryOutlet(state, producers)
        );
      });
    }
    if (skippable) state.skippable.add(nodeId);
  }
}

// ---------------------------------------------------------------- time order

/**
 * Whether every activation of `a` finishes before any activation of `b`
 * starts. Iterations of a loop run one after another; a node outside a loop
 * that consumes a member's output waits for the last iteration; a member
 * that cannot run on iteration 1 waits for everything iteration 1 waits for.
 */
export function graphNodeBefore(state: GraphCompileState, a: string, b: string): boolean {
  if (a === b || !state.order) return false;
  const loopA = state.loopOf.get(a);
  const loopB = state.loopOf.get(b);
  if (loopA !== undefined && loopA === loopB) return state.reaches(a, b);
  if (state.reaches(a, b)) return true;
  const fromA = loopA === undefined ? [a] : membersOf(state, loopA);
  if (loopA !== undefined && fromA.some((member) => state.reaches(member, b))) return true;
  if (loopB !== undefined && state.laterOnly.has(b)) {
    const membersB = membersOf(state, loopB);
    return membersB.some((member) => fromA.some((source) => state.reaches(source, member)));
  }
  return false;
}

/** Whether `a` and `b` can run at the same time. */
export function graphNodesConcurrent(state: GraphCompileState, a: string, b: string): boolean {
  if (a === b || graphNodeBefore(state, a, b) || graphNodeBefore(state, b, a)) return false;
  return !graphConditionsExclusive(
    state.conditions.get(a) ?? new Set(),
    state.conditions.get(b) ?? new Set(),
  );
}
