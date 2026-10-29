/**
 * The ready set (plan P2.3, report §4.3, §4.4, §8.2): which node positions of
 * a run can start now, which are skipped, and which wait.
 *
 * Pure: it reads a {@link GraphRunView} (the record plus the artifact values
 * the pass loaded) and returns the activations to create. Nodes are visited
 * in the plan's topological order, so a skip propagates downstream within one
 * call.
 *
 * ## Inputs are live, absent, pending or failed
 *
 * Each input port resolves from its edges and loop carries:
 *
 * - An edge delivers on the iterations it is for: `all`, `first` (iteration
 *   1 only) or `later` (from iteration 2). The compiler turns a port's
 *   `firstIterationFrom` into exactly such a `first`/`later` split.
 * - A carry (`<loopId>#<index>`) delivers from iteration 2, reading the
 *   producer's previous iteration (its latest live activation there); on
 *   iteration 1 it delivers nothing, so a loop's later-only entry is skipped
 *   there. A carry from a replicated producer collects its branches.
 * - An edge with transforms, or one the compiler could not prove fits the
 *   target's budgets (`budgetCheck`), delivers through
 *   `graph-edge-transforms.ts` once its source values are loaded: the same
 *   artifacts (filter and limit), new artifacts the pass stores first (pending
 *   until then), or a failure (`budget-exceeded`, `system-error`).
 * - A producer in the consumer's own loop is read at the same iteration; a
 *   producer inside a loop the consumer is not in is read at the loop's last
 *   iteration, once the loop is done; anything else at iteration 1.
 * - A producer activation that completed delivers its port's artifact; one
 *   that took another gate or human outlet, skipped, was cancelled, or failed
 *   without routing an `error` artifact delivers nothing (absent). One that is
 *   not terminal yet is pending. A taken outlet delivers what the gate or
 *   human node forwarded on that port, else the input it was given there (a
 *   list input stays a list). A `collect` merge delivers its input list
 *   unchanged. A failed activation delivers only its `error` port: the
 *   routed `error@1` artifact, pending while the runtime stores it.
 * - A replicated producer feeding a list port without `zip` (fan-in) is
 *   collected per the port's {@link GraphCollectPolicy} (item 205; see
 *   {@link collectGraphBranches}). A fan-in whose branches were all skipped
 *   is absent, so the skip propagates instead. With `zip`, branch k reads
 *   branch k (no fan-in). An unreplicated producer feeds every branch of a
 *   replicated consumer.
 * - A single-value port takes its (compiler-checked, mutually exclusive)
 *   live producer; a list port concatenates its live producers.
 *
 * ## A node position resolves to
 *
 * - `skipped` when a required input is absent, or its `when` is not true
 *   (three-valued: unknown is not true). Skips propagate: the skipped node's
 *   outputs are absent for its consumers, so a whole untaken subtree skips;
 *   a consumer with another live producer (a gate's `clean` outlet beside a
 *   skipped `address`) still runs.
 * - `failed` when a required fan-in port's collect policy cannot be met
 *   (`system-error`) or a required input's edge delivery fails; the node's
 *   `onFailure` then applies.
 * - `ready` with its inputs bound when every input is resolved and `when`
 *   holds.
 * - nothing yet while an input is pending, or while a `when` needs an
 *   artifact value the pass has not loaded (`needValues`).
 *
 * ## Collect policies (item 205; report §4.4)
 *
 * - `all-settled` waits until every branch is terminal and delivers every
 *   success, in branch order.
 * - `quorum` delivers once `count` branches succeeded: every success known
 *   then, in branch order. The other branches keep running; their results
 *   reach other consumers only.
 * - `first` delivers the first `count` successes by finish time (branch order
 *   breaks ties), listed in branch order. The pass then cancels the
 *   remaining branches when nothing else reads them (`graphSurplusBranches`
 *   in `graph-run-scheduling.ts`).
 * - Fewer than `minSuccessful` successes, possible or actual, fail the port.
 * - `includeFailures` adds each failed branch's failure marker (an `error@1`
 *   artifact the runtime records as the failed activation's `error` output,
 *   as for `onFailure: route`) to the list, in branch order; `all-settled`
 *   waits until the markers are stored, `quorum` and `first` include the
 *   ones already stored. Markers never count as successes. Merges skip them
 *   (except `collect`); an agent's prompt shows them as failed branches. Run
 *   outputs never include markers.
 */
import { GRAPH_DEFAULT_COLLECT_POLICY } from "@orkestrator/protocol/graphs/compile";
import type {
  CompiledGraphPlan,
  GraphPlanEdge,
  GraphPlanInputPort,
  GraphPlanNode,
} from "@orkestrator/protocol/graphs/compile";
import {
  evaluateGraphPredicate,
  type GraphPredicate,
} from "@orkestrator/protocol/graphs/predicates";
import { graphActivationKey, type NodeActivation } from "@orkestrator/protocol/graphs/run";
import { graphPlanScopeParams } from "@orkestrator/protocol/graphs/subgraphs";
import type {
  GraphCollectPolicy,
  GraphEdgeSource,
  GraphPortRef,
} from "@orkestrator/protocol/graphs/template";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import { graphEdgeNeedsDelivery, planGraphEdgeDelivery } from "./graph-edge-transforms.js";
import type { GraphRunView } from "./graph-run-view.js";

/** How one producer, port or node position resolves. */
export type GraphInputResolution =
  | { kind: "pending" }
  /** `markers`: the failure markers among `ids` (`includeFailures`), kept out of edge transforms. */
  | { kind: "live"; ids: string[]; markers?: string[] }
  | { kind: "absent" }
  | { kind: "failed"; message: string; cause?: GraphErrorCause };

/** The output port `onFailure: route` emits `error@1` on. */
export const GRAPH_ERROR_PORT = "error";

const PENDING: GraphInputResolution = { kind: "pending" };
const ABSENT: GraphInputResolution = { kind: "absent" };

export type GraphSkipReason = "input-absent" | "when-false";

export interface GraphReadySetResult {
  /** New activations in plan order: `ready`, `skipped` or `failed`. */
  created: NodeActivation[];
  /** Why each created `skipped` activation was skipped, by key. */
  skipReasons: Map<string, GraphSkipReason>;
  /** Artifact ids whose values a `when` needs before its node can resolve. */
  needValues: string[];
  /** Node positions still waiting on a pending input (or a value). */
  waiting: number;
}

function deliversOn(edge: GraphPlanEdge, iteration: number): boolean {
  return (
    edge.iterations === "all" ||
    (edge.iterations === "first" && iteration === 1) ||
    (edge.iterations === "later" && iteration > 1)
  );
}

function isListPort(port: GraphPlanInputPort): boolean {
  return port.fanIn || port.type.startsWith("list<");
}

function liveIds(ids: string | string[] | undefined): GraphInputResolution {
  if (ids === undefined) return ABSENT;
  return { kind: "live", ids: Array.isArray(ids) ? [...ids] : [ids] };
}

/**
 * What a terminal (or not) producer activation delivers on one port.
 * `producer` is the activation's plan node: it decides what a `collect`
 * merge and a routed failure deliver.
 */
export function graphActivationDelivery(
  activation: NodeActivation | undefined,
  port: string,
  outlet?: string,
  producer?: GraphPlanNode,
): GraphInputResolution {
  if (!activation) return PENDING;
  switch (activation.state) {
    case "complete": {
      if (outlet !== undefined) {
        // A taken outlet forwards the node's input on that port (an edited
        // value when a person changed it, item 208).
        if (activation.outlet !== outlet) return ABSENT;
        return liveIds(activation.outputs[port] ?? activation.inputs[port]);
      }
      if (producer?.kind === "merge" && producer.strategy.kind === "collect") {
        const input = producer.inputs[0];
        return input ? liveIds(activation.inputs[input.name] ?? []) : ABSENT;
      }
      return liveIds(activation.outputs[port]);
    }
    case "failed": {
      // `onFailure: route` delivers its `error@1` artifact on `error`; nothing else.
      if (outlet !== undefined || port !== GRAPH_ERROR_PORT) return ABSENT;
      const id = activation.outputs[port];
      if (id !== undefined) return { kind: "live", ids: [id] };
      // The runtime stores the routed error artifact before consumers read it.
      return producer?.onFailure === "route" ? PENDING : ABSENT;
    }
    case "skipped":
    case "cancelled":
    case "superseded":
      return ABSENT;
    default:
      return PENDING;
  }
}

/** Whether a loop is done: set by the loop evaluation of the same round. */
export type GraphLoopDone = (loopId: string) => boolean;

/** The iteration of `producer` a consumer at `iteration` reads, or null while its loop runs. */
function producerIteration(
  view: GraphRunView,
  producer: GraphPlanNode,
  consumer: GraphPlanNode | null,
  iteration: number,
  loopDone: GraphLoopDone,
): number | null {
  if (!producer.loop) return 1;
  if (consumer && consumer.loop === producer.loop) return iteration;
  return loopDone(producer.loop) ? view.iteration(producer.loop) : null;
}

/** A fan-in port's policy with the defaults filled (`all-settled`, 1, include failures). */
export function graphCollectPolicy(port: GraphPlanInputPort | null): GraphCollectPolicy {
  return port?.collect ?? GRAPH_DEFAULT_COLLECT_POLICY;
}

/**
 * Whether some fan-in reading `nodeId` (an edge without `zip`, or a loop
 * carry) passes failure markers downstream, so the runtime records one for
 * each of the node's failed branches.
 */
export function graphFailureMarkersWanted(plan: CompiledGraphPlan, nodeId: string): boolean {
  const port = (target: { node: string; port: string }) =>
    plan.nodes
      .find((node) => node.id === target.node)
      ?.inputs.find((input) => input.name === target.port) ?? null;
  const wants = (target: { node: string; port: string }) =>
    graphCollectPolicy(port(target)).includeFailures;
  return (
    plan.edges.some(
      (edge) =>
        "node" in edge.from &&
        edge.from.node === nodeId &&
        edge.from.outlet === undefined &&
        !edge.zip &&
        wants(edge.to),
    ) ||
    plan.loops.some((loop) =>
      loop.carry.some((carry) => carry.from.node === nodeId && wants(carry.to)),
    )
  );
}

/**
 * Collects a replicated producer's branches at one iteration for a fan-in
 * port (`null`: a run output) per its collect policy (module header).
 */
export function collectGraphBranches(
  view: GraphRunView,
  producer: GraphPlanNode,
  producerAt: number,
  source: GraphPortRef,
  port: GraphPlanInputPort | null,
): GraphInputResolution {
  const policy = graphCollectPolicy(port);
  const includeFailures = port !== null && policy.includeFailures && source.outlet === undefined;
  const branches = view.branchKeysOf(producer);
  const successes: { index: number; ids: string[]; finishedAt: string }[] = [];
  const markers: { index: number; id: string }[] = [];
  let pending = 0;
  let pendingMarkers = 0;
  let skipped = 0;
  branches.forEach((branchKey, index) => {
    const latest = view.latestAt(producer.id, producerAt, branchKey);
    if (latest?.state === "skipped") skipped += 1;
    const delivery = graphActivationDelivery(latest, source.port, source.outlet, producer);
    if (delivery.kind === "live") {
      successes.push({ index, ids: delivery.ids, finishedAt: latest?.finishedAt ?? "" });
    } else if (delivery.kind === "pending") {
      pending += 1;
    } else if (includeFailures && latest?.state === "failed") {
      const marker = latest.outputs[GRAPH_ERROR_PORT];
      if (marker !== undefined) markers.push({ index, id: marker });
      // The runtime stores the marker before an `all-settled` fan-in reads it.
      else if (
        producer.onFailure === "route" ||
        graphFailureMarkersWanted(view.plan, producer.id)
      ) {
        pendingMarkers += 1;
      }
    }
  });
  // Every branch skipped (an untaken outlet, a false `when`): the skip
  // propagates; the collect policy judges branches that ran.
  if (branches.length > 0 && skipped === branches.length) return ABSENT;
  const deliver = (taken: typeof successes): GraphInputResolution => {
    const entries = [
      ...taken.map((entry) => ({ index: entry.index, ids: entry.ids, marker: false })),
      ...markers.map((entry) => ({ index: entry.index, ids: [entry.id], marker: true })),
    ].sort((left, right) => left.index - right.index);
    const ids = entries.flatMap((entry) => entry.ids);
    const markerIds = entries.filter((entry) => entry.marker).flatMap((entry) => entry.ids);
    return { kind: "live", ids, ...(markerIds.length > 0 ? { markers: markerIds } : {}) };
  };
  // `quorum` and `first` deliver once `count` branches succeeded; `all-settled` waits for all.
  const target =
    policy.wait === "all-settled"
      ? null
      : Math.max(Math.min(policy.count ?? 1, branches.length), policy.minSuccessful);
  if (target !== null && successes.length >= target) {
    if (policy.wait === "quorum") return deliver(successes);
    // `first`: the earliest finishers; the rest are surplus.
    const earliest = [...successes]
      .sort(
        (left, right) =>
          left.finishedAt.localeCompare(right.finishedAt) || left.index - right.index,
      )
      .slice(0, target);
    return deliver(earliest);
  }
  if (pending > 0) {
    // Short of the bound even if every pending branch succeeds: fail now.
    if (successes.length + pending < policy.minSuccessful) {
      return collectFailure(port, successes.length, branches.length, policy.minSuccessful);
    }
    return PENDING;
  }
  if (successes.length < policy.minSuccessful) {
    return collectFailure(port, successes.length, branches.length, policy.minSuccessful);
  }
  if (pendingMarkers > 0) return PENDING;
  return deliver(successes);
}

function collectFailure(
  port: GraphPlanInputPort | null,
  succeeded: number,
  branches: number,
  required: number,
): GraphInputResolution {
  return {
    kind: "failed",
    message: `Input ${port?.name ?? "output"}: ${succeeded} of ${branches} branches succeeded; at least ${required} are required`,
  };
}

/**
 * Resolves one edge source for a consumer position. `consumer` is null for a
 * run output, which reads like a consumer outside every loop.
 */
export function resolveGraphEdgeSource(
  view: GraphRunView,
  source: GraphEdgeSource,
  options: {
    consumer: GraphPlanNode | null;
    port: GraphPlanInputPort | null;
    iteration: number;
    branchKey?: string;
    zip: boolean;
    loopDone: GraphLoopDone;
  },
): GraphInputResolution {
  if ("input" in source) {
    const id = view.run.bindings.inputs[source.input];
    return id === undefined ? ABSENT : { kind: "live", ids: [id] };
  }
  const producer = view.node(source.node);
  const at = producerIteration(
    view,
    producer,
    options.consumer,
    options.iteration,
    options.loopDone,
  );
  if (at === null) return PENDING;
  if (view.branchesOf(producer) === null) {
    return graphActivationDelivery(
      view.latestAt(producer.id, at),
      source.port,
      source.outlet,
      producer,
    );
  }
  if (options.zip && options.branchKey !== undefined) {
    return graphActivationDelivery(
      view.latestAt(producer.id, at, options.branchKey),
      source.port,
      source.outlet,
      producer,
    );
  }
  return collectGraphBranches(view, producer, at, source, options.port);
}

/**
 * Delivers a live edge source through the edge's transforms or budget check.
 * Memoised in the pass's outcomes by consumer activation, edge and source
 * ids; new artifacts are requested from the pass (pending until stored).
 */
function deliverThroughEdge(
  view: GraphRunView,
  consumer: { node: GraphPlanNode; key: string },
  port: GraphPlanInputPort,
  edgeId: string,
  ids: string[],
): GraphInputResolution {
  const key = `delivery\u0000${consumer.key}\u0000${edgeId}\u0000${ids.join(",")}`;
  const known = view.outcomes.get(key);
  if (known) {
    return known.ok
      ? { kind: "live", ids: [...known.ids] }
      : { kind: "failed", message: known.message, cause: known.cause };
  }
  const sources: { id: string; value: unknown }[] = [];
  for (const id of ids) {
    const loaded = view.values.get(id);
    if (loaded) sources.push({ id, value: loaded.value });
    else view.missingValues.add(id);
  }
  if (sources.length < ids.length) return PENDING;
  const edge = view.edge(edgeId);
  const delivery = planGraphEdgeDelivery({ plan: view.plan, edge, port, sources });
  switch (delivery.kind) {
    case "forward":
      view.outcomes.set(key, { ok: true, ids: delivery.ids });
      return { kind: "live", ids: [...delivery.ids] };
    case "failed":
      view.outcomes.set(key, { ok: false, message: delivery.message, cause: delivery.cause });
      return { kind: "failed", message: delivery.message, cause: delivery.cause };
    case "store":
      if (delivery.values.length === 0) {
        view.outcomes.set(key, { ok: true, ids: [] });
        return { kind: "live", ids: [] };
      }
      view.requests.set(key, {
        key,
        purpose: "delivery",
        producer: { nodeId: consumer.node.id, activation: consumer.key, port: port.name },
        type: delivery.type,
        values: delivery.values,
        inputs: delivery.inputs,
        edgeId,
        port: port.name,
      });
      return PENDING;
  }
}

/**
 * Resolves one input port of a node position from its edges and carries.
 * With `deliver`, an edge that needs its values at delivery (transforms, a
 * budget check) goes through them; without, the raw source ids stand in, so
 * a position can be judged skipped or waiting before anything is stored.
 */
export function resolveGraphInputPort(
  view: GraphRunView,
  node: GraphPlanNode,
  port: GraphPlanInputPort,
  iteration: number,
  branchKey: string | undefined,
  loopDone: GraphLoopDone,
  deliver?: { key: string },
): GraphInputResolution {
  const sources: GraphInputResolution[] = [];
  for (const edgeId of port.edges) {
    const edge = view.edge(edgeId);
    if (!deliversOn(edge, iteration)) continue;
    let resolved = resolveGraphEdgeSource(view, edge.from, {
      consumer: node,
      port,
      iteration,
      ...(branchKey !== undefined ? { branchKey } : {}),
      zip: edge.zip,
      loopDone,
    });
    if (deliver && resolved.kind === "live" && graphEdgeNeedsDelivery(edge)) {
      // Failure markers are not values of the edge's type: they bypass its
      // transforms and follow the delivered values.
      const markers = resolved.markers ?? [];
      const values = resolved.ids.filter((id) => !markers.includes(id));
      const delivered = deliverThroughEdge(view, { node, key: deliver.key }, port, edge.id, values);
      resolved =
        delivered.kind === "live" && markers.length > 0
          ? { kind: "live", ids: [...delivered.ids, ...markers], markers }
          : delivered;
    }
    sources.push(resolved);
  }
  if (iteration > 1) {
    for (const carryId of port.carries) {
      const { carry } = view.carry(carryId);
      const producer = view.node(carry.from.node);
      // A carry reads the producer's previous iteration; a replicated producer's branches are collected.
      sources.push(
        view.branchesOf(producer) === null
          ? graphActivationDelivery(
              view.latestAt(producer.id, iteration - 1),
              carry.from.port,
              carry.from.outlet,
              producer,
            )
          : collectGraphBranches(view, producer, iteration - 1, carry.from, port),
      );
    }
  }
  if (sources.length === 0) return ABSENT;
  if (isListPort(port)) {
    const failed = sources.find((source) => source.kind === "failed");
    if (failed) return failed;
    if (sources.some((source) => source.kind === "pending")) return PENDING;
    const live = sources.filter((source) => source.kind === "live");
    if (live.length === 0) return ABSENT;
    const markers = live.flatMap((source) => source.markers ?? []);
    return {
      kind: "live",
      ids: live.flatMap((source) => source.ids),
      ...(markers.length > 0 ? { markers } : {}),
    };
  }
  const live = sources.find((source) => source.kind === "live" && source.ids.length > 0);
  if (live && live.kind === "live") return { kind: "live", ids: [live.ids[0]!] };
  if (sources.some((source) => source.kind === "pending")) return PENDING;
  return sources.find((source) => source.kind === "failed") ?? ABSENT;
}

/** Paths a predicate reads, for loading only the values it needs. */
export function graphPredicatePaths(predicate: GraphPredicate): string[] {
  const paths: string[] = [];
  const visit = (node: GraphPredicate) => {
    if ("all" in node) node.all.forEach(visit);
    else if ("any" in node) node.any.forEach(visit);
    else if ("not" in node) visit(node.not);
    else paths.push(node.path);
  };
  visit(predicate);
  return paths;
}

/** The values a `when` reads, or the ids still to load. */
function whenValues(
  view: GraphRunView,
  node: GraphPlanNode,
  inputs: Record<string, string | string[]>,
): { values: Record<string, unknown> } | { missing: string[] } {
  const roots = new Set(graphPredicatePaths(node.when!).map((path) => path.split(".")[0]!));
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [port, bound] of Object.entries(inputs)) {
    if (!roots.has(port)) continue;
    const ids = Array.isArray(bound) ? bound : [bound];
    const loaded = ids.map((id) => view.values.get(id));
    loaded.forEach((entry, index) => {
      if (!entry) missing.push(ids[index]!);
    });
    if (missing.length > 0) continue;
    values[port] = Array.isArray(bound) ? loaded.map((entry) => entry!.value) : loaded[0]!.value;
  }
  return missing.length > 0 ? { missing } : { values };
}

function activation(
  view: GraphRunView,
  node: GraphPlanNode,
  iteration: number,
  branchKey: string | undefined,
  state: "ready" | "skipped" | "failed",
  inputs: Record<string, string | string[]>,
  at: string,
  failure?: { message: string; cause: GraphErrorCause },
): NodeActivation {
  const attempt = view.nextAttempt(node.id, iteration, branchKey);
  const parts = {
    nodeId: node.id,
    iteration,
    attempt,
    ...(branchKey !== undefined ? { branchKey } : {}),
  };
  return {
    key: graphActivationKey(parts),
    ...parts,
    state,
    inputs,
    outputs: {},
    createdAt: at,
    ...(state === "ready" ? {} : { finishedAt: at }),
    ...(failure !== undefined ? { error: failure.message, errorCause: failure.cause } : {}),
  };
}

/**
 * The activations to create for every unresolved node position at the
 * nodes' current iterations. Records each in `view` as it goes.
 */
export function computeGraphReadySet(
  view: GraphRunView,
  options: { at: string; loopDone: GraphLoopDone },
): GraphReadySetResult {
  const created: NodeActivation[] = [];
  const skipReasons = new Map<string, GraphSkipReason>();
  const needValues = new Set<string>();
  let waiting = 0;
  for (const node of view.plan.nodes) {
    const iteration = view.nodeIteration(node);
    // A loop that is done creates nothing more at its last iteration.
    for (const branchKey of view.branchKeysOf(node)) {
      if (view.latestAt(node.id, iteration, branchKey)) continue;
      const resolvePorts = (deliver?: { key: string }) => {
        const inputs: Record<string, string | string[]> = {};
        let pending = false;
        let absent = false;
        let failure: { message: string; cause: GraphErrorCause } | undefined;
        for (const port of node.inputs) {
          const resolved = resolveGraphInputPort(
            view,
            node,
            port,
            iteration,
            branchKey,
            options.loopDone,
            deliver,
          );
          if (resolved.kind === "pending") pending = true;
          else if (resolved.kind === "failed") {
            if (port.required) {
              failure ??= { message: resolved.message, cause: resolved.cause ?? "system-error" };
            }
          } else if (resolved.kind === "absent") {
            if (port.required) absent = true;
          } else {
            inputs[port.name] = isListPort(port) ? resolved.ids : resolved.ids[0]!;
          }
        }
        return { inputs, pending, absent, failure };
      };
      // Judge the position on its raw sources first; deliver through edge
      // transforms only once no input is pending or absent, so a node skipped
      // for an absent input stores nothing. (`when` reads delivered values.)
      let ports = resolvePorts();
      if (
        !ports.absent &&
        !ports.pending &&
        ports.failure === undefined &&
        node.inputs.some((port) =>
          port.edges.some((edgeId) => graphEdgeNeedsDelivery(view.edge(edgeId))),
        )
      ) {
        const key = graphActivationKey({
          nodeId: node.id,
          iteration,
          attempt: view.nextAttempt(node.id, iteration, branchKey),
          ...(branchKey !== undefined ? { branchKey } : {}),
        });
        ports = resolvePorts({ key });
      }
      const { inputs, pending, absent, failure } = ports;
      let next: NodeActivation | null = null;
      if (absent) {
        // A definitely absent required input skips the node whatever else is pending.
        next = activation(view, node, iteration, branchKey, "skipped", {}, options.at);
        skipReasons.set(next.key, "input-absent");
      } else if (pending) {
        waiting += 1;
      } else if (failure !== undefined) {
        next = activation(view, node, iteration, branchKey, "failed", inputs, options.at, failure);
      } else if (node.when) {
        const scope = whenValues(view, node, inputs);
        if ("missing" in scope) {
          scope.missing.forEach((id) => needValues.add(id));
          waiting += 1;
        } else {
          const decision = evaluateGraphPredicate(node.when, {
            values: scope.values,
            params: graphPlanScopeParams(view.run.plan, node.subgraph, view.run.bindings.params),
            run: { iteration },
          });
          next = activation(
            view,
            node,
            iteration,
            branchKey,
            decision.value ? "ready" : "skipped",
            decision.value ? inputs : {},
            options.at,
          );
          if (!decision.value) skipReasons.set(next.key, "when-false");
        }
      } else {
        next = activation(view, node, iteration, branchKey, "ready", inputs, options.at);
      }
      if (next) {
        created.push(next);
        view.add(next);
      }
    }
  }
  view.missingValues.forEach((id) => needValues.add(id));
  return { created, skipReasons, needValues: [...needValues], waiting };
}
