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
 *   producer's previous iteration; on iteration 1 it delivers nothing, so a
 *   loop's later-only entry is skipped there.
 * - A producer in the consumer's own loop is read at the same iteration; a
 *   producer inside a loop the consumer is not in is read at the loop's last
 *   iteration, once the loop is done; anything else at iteration 1.
 * - A producer activation that completed delivers its port's artifact; one
 *   that took another gate or human outlet, skipped, was cancelled, or failed
 *   without routing an `error` artifact delivers nothing (absent). One that is
 *   not terminal yet is pending.
 * - A replicated producer feeding a list port without `zip` (fan-in) is
 *   collected per the port's {@link GraphCollectPolicy}: `all-settled` waits
 *   for every branch, `quorum` and `first` for `count` successes. Fewer than
 *   `minSuccessful` successes fail the port. With `zip`, branch k reads branch
 *   k. An unreplicated producer feeds every branch of a replicated consumer.
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
 * - `failed` (cause `system-error`) when a required fan-in port's collect
 *   policy cannot be met; the node's `onFailure` then applies.
 * - `ready` with its inputs bound when every input is resolved and `when`
 *   holds.
 * - nothing yet while an input is pending, or while a `when` needs an
 *   artifact value the pass has not loaded (`needValues`).
 *
 * Collect policy gaps left to item 205: `first` cancelling the remaining
 * branches, and `includeFailures` failure markers in the delivered list (the
 * list carries the successful artifacts only).
 */
import { GRAPH_DEFAULT_COLLECT_POLICY } from "@orkestrator/protocol/graphs/compile";
import type {
  GraphPlanEdge,
  GraphPlanInputPort,
  GraphPlanNode,
} from "@orkestrator/protocol/graphs/compile";
import {
  evaluateGraphPredicate,
  type GraphPredicate,
} from "@orkestrator/protocol/graphs/predicates";
import { graphActivationKey, type NodeActivation } from "@orkestrator/protocol/graphs/run";
import type { GraphEdgeSource, GraphPortRef } from "@orkestrator/protocol/graphs/template";
import type { GraphRunView } from "./graph-run-view.js";

/** How one producer, port or node position resolves. */
export type GraphInputResolution =
  | { kind: "pending" }
  | { kind: "live"; ids: string[] }
  | { kind: "absent" }
  | { kind: "failed"; message: string };

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

/** What a terminal (or not) producer activation delivers on one port. */
export function graphActivationDelivery(
  activation: NodeActivation | undefined,
  port: string,
  outlet?: string,
): GraphInputResolution {
  if (!activation) return PENDING;
  switch (activation.state) {
    case "complete": {
      if (outlet !== undefined && activation.outlet !== outlet) return ABSENT;
      const id = activation.outputs[port];
      return id === undefined ? ABSENT : { kind: "live", ids: [id] };
    }
    case "failed": {
      // `onFailure: route` delivers its error artifact; nothing else.
      const id = outlet === undefined ? activation.outputs[port] : undefined;
      return id === undefined ? ABSENT : { kind: "live", ids: [id] };
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

function collect(
  view: GraphRunView,
  producer: GraphPlanNode,
  producerAt: number,
  source: GraphPortRef,
  port: GraphPlanInputPort | null,
): GraphInputResolution {
  const policy = port?.collect ?? GRAPH_DEFAULT_COLLECT_POLICY;
  const branches = view.branchKeysOf(producer);
  const ids: string[] = [];
  let pending = 0;
  for (const branchKey of branches) {
    const delivery = graphActivationDelivery(
      view.latestAt(producer.id, producerAt, branchKey),
      source.port,
      source.outlet,
    );
    if (delivery.kind === "live") ids.push(...delivery.ids);
    else if (delivery.kind === "pending") pending += 1;
  }
  // `quorum` and `first` deliver once `count` branches succeeded; `all-settled` waits for all.
  const target =
    policy.wait === "all-settled" ? null : Math.min(policy.count ?? 1, branches.length);
  if (target !== null && ids.length >= Math.max(target, policy.minSuccessful)) {
    return { kind: "live", ids };
  }
  if (pending > 0) {
    // Short of the bound even if every pending branch succeeds: fail now.
    if (ids.length + pending < policy.minSuccessful) {
      return collectFailure(port, ids.length, branches.length, policy.minSuccessful);
    }
    return PENDING;
  }
  if (ids.length >= policy.minSuccessful) return { kind: "live", ids };
  return collectFailure(port, ids.length, branches.length, policy.minSuccessful);
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
    return graphActivationDelivery(view.latestAt(producer.id, at), source.port, source.outlet);
  }
  if (options.zip && options.branchKey !== undefined) {
    return graphActivationDelivery(
      view.latestAt(producer.id, at, options.branchKey),
      source.port,
      source.outlet,
    );
  }
  return collect(view, producer, at, source, options.port);
}

/** Resolves one input port of a node position from its edges and carries. */
export function resolveGraphInputPort(
  view: GraphRunView,
  node: GraphPlanNode,
  port: GraphPlanInputPort,
  iteration: number,
  branchKey: string | undefined,
  loopDone: GraphLoopDone,
): GraphInputResolution {
  const sources: GraphInputResolution[] = [];
  for (const edgeId of port.edges) {
    const edge = view.edge(edgeId);
    if (!deliversOn(edge, iteration)) continue;
    sources.push(
      resolveGraphEdgeSource(view, edge.from, {
        consumer: node,
        port,
        iteration,
        ...(branchKey !== undefined ? { branchKey } : {}),
        zip: edge.zip,
        loopDone,
      }),
    );
  }
  if (iteration > 1) {
    for (const carryId of port.carries) {
      const { carry } = view.carry(carryId);
      const producer = view.node(carry.from.node);
      const producerBranch = view.branchesOf(producer) === null ? undefined : branchKey;
      sources.push(
        graphActivationDelivery(
          view.latestAt(producer.id, iteration - 1, producerBranch),
          carry.from.port,
          carry.from.outlet,
        ),
      );
    }
  }
  if (sources.length === 0) return ABSENT;
  if (isListPort(port)) {
    const failed = sources.find((source) => source.kind === "failed");
    if (failed) return failed;
    if (sources.some((source) => source.kind === "pending")) return PENDING;
    const live = sources.filter((source) => source.kind === "live");
    return live.length === 0 ? ABSENT : { kind: "live", ids: live.flatMap((source) => source.ids) };
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
  failure?: string,
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
    ...(failure !== undefined ? { error: failure, errorCause: "system-error" as const } : {}),
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
      const inputs: Record<string, string | string[]> = {};
      let pending = false;
      let absent = false;
      let failure: string | undefined;
      for (const port of node.inputs) {
        const resolved = resolveGraphInputPort(
          view,
          node,
          port,
          iteration,
          branchKey,
          options.loopDone,
        );
        if (resolved.kind === "pending") pending = true;
        else if (resolved.kind === "failed") {
          if (port.required) failure ??= resolved.message;
        } else if (resolved.kind === "absent") {
          if (port.required) absent = true;
        } else {
          inputs[port.name] = isListPort(port) ? resolved.ids : resolved.ids[0]!;
        }
      }
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
            params: view.run.bindings.params,
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
  return { created, skipReasons, needValues: [...needValues], waiting };
}
