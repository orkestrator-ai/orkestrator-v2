/**
 * The run view's own activation actions (item 211, plan P2.11): retry one
 * failed node position, and skip a position that was not admitted yet. Pure
 * record transforms; {@link GraphRunService.retry} and
 * {@link GraphRunService.skip} apply them under the run's lock and save with
 * compare-and-swap. Restart from a node and code rewind are item 210's.
 *
 * **Retry** (report §8.4: "the user can retry one branch") reruns a failed
 * activation's position as a new attempt with the same inputs, while the run
 * is still live. It records a `restart` rewind requested by the user that
 * supersedes:
 *
 * - the failed activation, every artifact it produced (a routed `error@1`)
 *   and everything that consumed those, transitively
 *   (`graphLineageDescendants`), so a recovery branch reruns; and
 * - the never-started markers the failure left downstream (`skipped`,
 *   `failed` or `cancelled` activations of nodes the plan's edges or loop
 *   carries reach from this node, created after it): they carry no artifact,
 *   so lineage cannot find them, and the ready set must decide them again.
 *   Re-deciding is deterministic, so a marker another cause produced (an
 *   untaken gate outlet) comes back the same.
 *
 * A consumer that already ran without the failed branch's output (a fan-in
 * that collected the other branches) is not rerun: it never consumed
 * anything of this branch. Restarting that consumer (item 210) covers it.
 *
 * **Skip** settles a `waiting` or `ready` activation (held back by a pause, a
 * workspace lock or the run's limits) as `skipped`; consumers that require
 * its outputs are then skipped by the ready set.
 */
import {
  graphActivationRetryRefusal,
  graphActivationSkipRefusal,
} from "@orkestrator/protocol/graphs/run-view";
import {
  applyGraphRewind,
  graphLineageDescendants,
  graphRunActivation,
  type GraphArtifact,
  type GraphRewind,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import { settleGraphActivation } from "./graph-run-transitions.js";

export type GraphRunUserActionRefusal = {
  ok: false;
  code: "not-found" | "invalid-state";
  message: string;
};

export type GraphRunRetryPlan =
  { ok: true; run: GraphRun; rewind: GraphRewind } | GraphRunUserActionRefusal;

export type GraphRunSkipPlan = { ok: true; run: GraphRun } | GraphRunUserActionRefusal;

/** Node ids the plan's edges and loop carries reach from `nodeId`, transitively (itself excluded). */
export function graphPlanDownstreamNodes(run: Pick<GraphRun, "plan">, nodeId: string): Set<string> {
  const next = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    if (!next.has(from)) next.set(from, []);
    next.get(from)!.push(to);
  };
  for (const edge of run.plan.edges) {
    if ("node" in edge.from) link(edge.from.node, edge.to.node);
  }
  for (const loop of run.plan.loops) {
    for (const carry of loop.carry) link(carry.from.node, carry.to.node);
  }
  const reached = new Set<string>();
  const queue = [...(next.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reached.has(id) || id === nodeId) continue;
    reached.add(id);
    queue.push(...(next.get(id) ?? []));
  }
  return reached;
}

function neverStartedMarker(activation: NodeActivation): boolean {
  return (
    (activation.state === "skipped" ||
      activation.state === "failed" ||
      activation.state === "cancelled") &&
    activation.startedAt === undefined &&
    activation.session === undefined
  );
}

/** Plans a retry of `activationKey` as a `restart` rewind with id `rewindId`. */
export function planGraphRunRetry(
  run: GraphRun,
  artifacts: readonly GraphArtifact[],
  activationKey: string,
  options: { rewindId: string; at: string },
): GraphRunRetryPlan {
  const activation = graphRunActivation(run, activationKey);
  if (!activation)
    return { ok: false, code: "not-found", message: "The run has no such activation" };
  const refusal = graphActivationRetryRefusal(run, activation);
  if (refusal) return { ok: false, code: "invalid-state", message: refusal };
  const lineage = graphLineageDescendants(run, artifacts, activationKey);
  if (!lineage) {
    return { ok: false, code: "invalid-state", message: "The activation is already superseded" };
  }
  const downstream = graphPlanDownstreamNodes(run, activation.nodeId);
  const node = run.plan.nodes.find((candidate) => candidate.id === activation.nodeId);
  const superseded = new Set(lineage.activations);
  for (const candidate of run.activations) {
    if (candidate.state === "superseded" || superseded.has(candidate.key)) continue;
    if (!downstream.has(candidate.nodeId) || !neverStartedMarker(candidate)) continue;
    if (candidate.createdAt < activation.createdAt) continue;
    const candidateNode = run.plan.nodes.find((entry) => entry.id === candidate.nodeId);
    // Inside the same loop, earlier rounds keep their markers.
    if (
      node?.loop !== undefined &&
      candidateNode?.loop === node.loop &&
      candidate.iteration < activation.iteration
    ) {
      continue;
    }
    superseded.add(candidate.key);
  }
  const order = new Map(run.activations.map((entry, index) => [entry.key, index]));
  const rewind: GraphRewind = {
    id: options.rewindId,
    kind: "restart",
    nodeId: activation.nodeId,
    activation: activation.key,
    iteration: activation.iteration,
    requestedAt: options.at,
    requestedBy: "user",
    superseded: {
      activations: [...superseded].sort((left, right) =>
        left === activation.key
          ? -1
          : right === activation.key
            ? 1
            : order.get(left)! - order.get(right)!,
      ),
      artifacts: lineage.artifacts,
    },
  };
  const applied = applyGraphRewind(run, rewind);
  if (!applied.ok) return { ok: false, code: "invalid-state", message: applied.message };
  return { ok: true, run: applied.run, rewind };
}

/** Plans a skip of a `waiting` or `ready` activation. */
export function planGraphRunSkip(
  run: GraphRun,
  activationKey: string,
  at: string,
): GraphRunSkipPlan {
  const activation = graphRunActivation(run, activationKey);
  if (!activation)
    return { ok: false, code: "not-found", message: "The run has no such activation" };
  const refusal = graphActivationSkipRefusal(run, activation);
  if (refusal) return { ok: false, code: "invalid-state", message: refusal };
  return { ok: true, run: settleGraphActivation(run, activationKey, "skipped", at) };
}
