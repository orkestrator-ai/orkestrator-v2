/**
 * Restart and rewind as graph operations (plan P2.10, D8, report §8.5): what
 * a restart of one activation supersedes, when a run allows one, and the
 * shapes of the `graph_run_restart`, `graph_run_rewind_code_preview` and
 * `graph_run_rewind_code` commands.
 *
 * ## What a restart supersedes
 *
 * With dataflow and lineage, "what comes after" is precise. A restart of
 * activation X supersedes ({@link graphRestartScope}):
 *
 * - X, every artifact it produced, and, transitively, every activation that
 *   consumed one of those artifacts and every artifact derived from them
 *   (the lineage, as `graphLineageDescendants`);
 * - every activation that *read* a superseded activation's node over an edge
 *   or a loop carry at a matching position, consumed artifact or not. That
 *   covers the consumers of a gate or human node, which forward artifacts
 *   their upstream produced (the forwarded artifacts themselves are kept),
 *   and the activations a superseded node's outcome skipped or failed, which
 *   recorded no inputs;
 * - inside a loop, every member activation of an iteration after the
 *   earliest superseded one: the loop's counter rewinds to that iteration,
 *   so the later iterations have not happened yet. Carried inputs of the
 *   rerun come from the previous iteration's live artifacts, which stay.
 *
 * Everything else is kept: an independent branch stays done, and earlier
 * attempts stay superseded as they were. A position is "matching" when the
 * reader is in the same loop at the same iteration (a carry: the next one),
 * on the same branch for a `zip` edge, and anywhere otherwise.
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */
import { graphNodeIsolated } from "./isolation.js";
import type { GraphPlanNode } from "./plan.js";
import { graphRunActivation } from "./run-lineage.js";
import type { GraphArtifact, GraphRewind, GraphRun, NodeActivation } from "./run-model.js";

/** Commits a code-rewind preview lists (the pipeline's bound). */
export const GRAPH_CODE_REWIND_PREVIEW_COMMITS = 50;
/** Uncommitted paths a refused code-rewind preview names. */
export const GRAPH_CODE_REWIND_PREVIEW_PATHS = 20;
/** Node ids a preview names as rerunning. */
export const GRAPH_REWIND_PREVIEW_NODES = 64;

export interface GraphRestartScope {
  /** Activation keys, the restarted one first, then in record order. */
  activations: string[];
  /** Artifact ids, sorted. */
  artifacts: string[];
  /** Loop id → the iteration its counter rewinds to (only loops that move back). */
  loopIterations: Record<string, number>;
}

interface GraphReader {
  /** The producing node. */
  node: string;
  zip: boolean;
  carry: boolean;
}

/** Consumer node id → the edges and carries it reads, by producing node. */
function readersByConsumer(run: GraphRun): Map<string, GraphReader[]> {
  const readers = new Map<string, GraphReader[]>();
  const add = (consumer: string, reader: GraphReader) => {
    const list = readers.get(consumer);
    if (list) list.push(reader);
    else readers.set(consumer, [reader]);
  };
  for (const edge of run.plan.edges) {
    if ("node" in edge.from)
      add(edge.to.node, { node: edge.from.node, zip: edge.zip, carry: false });
  }
  for (const loop of run.plan.loops) {
    for (const carry of loop.carry) {
      add(carry.to.node, { node: carry.from.node, zip: false, carry: true });
    }
  }
  return readers;
}

/** Whether `reader` at its position reads `producer`'s position (see the module comment). */
function readsPosition(
  nodes: ReadonlyMap<string, GraphPlanNode>,
  producer: NodeActivation,
  consumer: NodeActivation,
  reader: GraphReader,
): boolean {
  const loop = nodes.get(producer.nodeId)?.loop;
  if (loop !== undefined && loop === nodes.get(consumer.nodeId)?.loop) {
    const expected = reader.carry ? producer.iteration + 1 : producer.iteration;
    if (consumer.iteration !== expected) return false;
  }
  if (
    reader.zip &&
    producer.branchKey !== undefined &&
    consumer.branchKey !== undefined &&
    producer.branchKey !== consumer.branchKey
  ) {
    return false;
  }
  return true;
}

/**
 * Exactly what a restart of `activationKey` supersedes, and the loop
 * counters it rewinds (see the module comment). Null when the activation
 * does not exist or is already superseded.
 */
export function graphRestartScope(
  run: GraphRun,
  artifacts: readonly GraphArtifact[],
  activationKey: string,
): GraphRestartScope | null {
  const root = graphRunActivation(run, activationKey);
  if (!root || root.state === "superseded") return null;
  const nodes = new Map(run.plan.nodes.map((node) => [node.id, node]));
  const readers = readersByConsumer(run);
  const live = run.activations.filter((activation) => activation.state !== "superseded");
  const liveByKey = new Map(live.map((activation) => [activation.key, activation]));
  const liveArtifacts = artifacts.filter(
    (artifact) => artifact.state === "live" && artifact.runId === run.id,
  );
  const activationSet = new Set<string>([root.key]);
  const artifactSet = new Set<string>();
  /** Node id → its superseded activations, for the readers. */
  const byNode = new Map<string, NodeActivation[]>();
  /** Loop id → the earliest iteration with a superseded member activation. */
  const earliest = new Map<string, number>();
  const supersede = (activation: NodeActivation) => {
    activationSet.add(activation.key);
    const list = byNode.get(activation.nodeId);
    if (list) list.push(activation);
    else byNode.set(activation.nodeId, [activation]);
    const loop = nodes.get(activation.nodeId)?.loop;
    if (loop !== undefined) {
      earliest.set(
        loop,
        Math.min(earliest.get(loop) ?? activation.iteration, activation.iteration),
      );
    }
  };
  supersede(root);
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of liveArtifacts) {
      if (artifactSet.has(artifact.id)) continue;
      if (
        activationSet.has(artifact.producer.activation) ||
        artifact.inputs.some((input) => artifactSet.has(input))
      ) {
        artifactSet.add(artifact.id);
        changed = true;
        // Made in another activation's name from superseded lineage (an edge delivery).
        const producer = liveByKey.get(artifact.producer.activation);
        if (producer && !activationSet.has(producer.key)) supersede(producer);
      }
    }
    for (const activation of live) {
      if (activationSet.has(activation.key)) continue;
      const consumed = Object.values(activation.inputs).some((ids) =>
        (Array.isArray(ids) ? ids : [ids]).some((id) => artifactSet.has(id)),
      );
      const loop = nodes.get(activation.nodeId)?.loop;
      const rewoundIteration =
        loop !== undefined &&
        earliest.has(loop) &&
        activation.iteration > (earliest.get(loop) as number);
      const reads =
        !consumed &&
        !rewoundIteration &&
        (readers.get(activation.nodeId) ?? []).some((reader) =>
          (byNode.get(reader.node) ?? []).some((producer) =>
            readsPosition(nodes, producer, activation, reader),
          ),
        );
      if (consumed || rewoundIteration || reads) {
        supersede(activation);
        changed = true;
      }
    }
  }
  const order = new Map(run.activations.map((activation, index) => [activation.key, index]));
  const loopIterations: Record<string, number> = {};
  for (const [loop, iteration] of earliest) {
    if (iteration < (run.loopIterations[loop] ?? 1)) loopIterations[loop] = iteration;
  }
  return {
    activations: [...activationSet].sort((left, right) =>
      left === root.key ? -1 : right === root.key ? 1 : order.get(left)! - order.get(right)!,
    ),
    artifacts: [...artifactSet].sort(),
    loopIterations,
  };
}

const ADMITTED_STATES = new Set(["admitting", "running", "awaiting-human"]);

/**
 * Why the run does not allow restarting `activationKey` now, or undefined
 * when it does. The command also accepts a repeated request for an activation
 * the newest rewind superseded (a no-op); this reads the plain rule, for a
 * view that greys out "Restart from here".
 *
 * Restart rules (the pipeline's, applied to runs): a running, waiting or
 * paused run restarts in place; a complete, failed or cancelled run reopens
 * (a restart is an explicit instruction to keep going); a run still
 * provisioning or stopping (`cancelling`) refuses.
 */
export function graphRunRestartBlocker(
  run: Pick<GraphRun, "status" | "activations">,
  activationKey: string,
): string | undefined {
  if (run.status === "provisioning") {
    return "The run is still preparing its environment. Restart once it has started.";
  }
  if (run.status === "cancelling") {
    return "The run is stopping. Restart a node once it has stopped.";
  }
  const activation = run.activations.find((entry) => entry.key === activationKey);
  if (!activation) return "The run has no such activation.";
  if (activation.state === "superseded") {
    return "This activation belongs to a previous attempt. Restart its current attempt instead.";
  }
  const later = run.activations.some(
    (entry) =>
      entry.state !== "superseded" &&
      entry.nodeId === activation.nodeId &&
      entry.iteration === activation.iteration &&
      entry.branchKey === activation.branchKey &&
      entry.attempt > activation.attempt,
  );
  if (later) return "A later attempt of this node exists. Restart that one instead.";
  return undefined;
}

/**
 * The run-state part of the code-rewind refusals, or undefined. The
 * worktree (clean, HEAD, ancestry), the pull request and the node's input
 * commit are checked by the backend. Code rewinds need a quiet workspace:
 * the run must be paused or finished and no activation may still be
 * admitted (the pipeline's "pause first" rule); a mock run never changes code.
 * An isolated branch (item 403) is never rewound: a restart already starts it
 * from its input commit in a fresh worktree.
 */
export function graphRunCodeRewindBlocker(
  run: Pick<GraphRun, "status" | "activations" | "mock"> & {
    plan?: { nodes: ReadonlyArray<{ id: string; kind: string; isolation?: "worktree" }> };
  },
  activationKey: string,
): string | undefined {
  if (run.mock) return "A mock run never changes code.";
  const restart = graphRunRestartBlocker(run, activationKey);
  if (restart) return restart;
  const activation = run.activations.find((entry) => entry.key === activationKey);
  const node = run.plan?.nodes.find((entry) => entry.id === activation?.nodeId);
  if (node && graphNodeIsolated(node)) {
    return "This branch works in its own worktree, created from its input commit on every attempt. Restart it instead; the run's branch is not reset.";
  }
  if (run.status === "running" || run.status === "waiting") {
    return "Pause the run first: a running node could write to the worktree during the reset.";
  }
  const admitted = run.activations.filter((activation) =>
    ADMITTED_STATES.has(activation.state),
  ).length;
  if (admitted > 0) {
    return `Wait for the run's ${admitted === 1 ? "running node" : `${admitted} running nodes`} to stop before rewinding code.`;
  }
  return undefined;
}

// ---------------------------------------------------------------- commands

/** `graph_run_restart {runId, activationKey, requestId?}`. */
export interface GraphRunRestartRequest {
  runId: string;
  activationKey: string;
  /** Repeating a request id is a no-op; at most 128 `[A-Za-z0-9_-]` characters. */
  requestId?: string;
}

/** `graph_run_rewind_code {runId, activationKey, expectedHead, requestId?}`. */
export interface GraphRunCodeRewindRequest extends GraphRunRestartRequest {
  /** The HEAD the confirmed preview showed; a branch that moved since is refused. */
  expectedHead: string;
}

/** What a restart or a code rewind did. */
export interface GraphRunRestartResult {
  /** The stored run after the rewind. */
  run: GraphRun;
  rewind: GraphRewind;
  /** The same request again: nothing changed. */
  repeated: boolean;
}

/** What "Rewind code to here" would do, shown before the user confirms it. */
export interface GraphRunCodeRewindPreview {
  runId: string;
  activationKey: string;
  nodeId: string;
  iteration: number;
  /** The commit of the node's input `workspace@1` artifact. */
  targetCommit?: string;
  /** The worktree HEAD the preview read; the confirmed rewind must still find it. */
  head?: string;
  /** Commits the reset drops, newest first, at most {@link GRAPH_CODE_REWIND_PREVIEW_COMMITS}. */
  commits: { sha: string; subject: string }[];
  commitCount: number;
  /** The branch's upstream and how many of its commits the next push force-removes. */
  upstream?: { ref: string; droppedCommits: number };
  /** The environment's pull request, when this run opened one. */
  pullRequest?: { url: string; state: string };
  /** Uncommitted paths that block the reset, at most {@link GRAPH_CODE_REWIND_PREVIEW_PATHS}. */
  uncommittedPaths?: string[];
  /** What the restart after the reset supersedes. */
  supersedes: {
    activations: number;
    artifacts: number;
    /** Distinct node ids that rerun, plan order, at most {@link GRAPH_REWIND_PREVIEW_NODES}. */
    nodes: string[];
  };
  /** Why the rewind cannot run now; the confirmation is disabled when set. */
  blocked?: string;
}
