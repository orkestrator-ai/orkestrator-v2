/**
 * Pure helpers the runtime uses on a run record and its artifacts (plan P2.1,
 * report §5.4, §8.5): bounded appends, live artifacts for a port, lineage
 * descendants for a restart, and applying a rewind.
 *
 * Every helper returns a new record (the input is never mutated) or a typed
 * refusal, so a scheduler pass can build the next record and then save it
 * with compare-and-swap. Superseding never deletes: activations and artifacts
 * stay in the record and the store with their marks (invariant 3).
 */
import { supersedeGraphItemFanOuts } from "./run-fanout.js";
import { parseGraphActivationKey } from "./run-identity.js";
import {
  GRAPH_ACTIVATION_TERMINAL_STATES,
  GRAPH_RUN_BOUNDS,
  GRAPH_RUN_TERMINAL_STATUSES,
  type GraphActivationState,
  type GraphArtifact,
  type GraphRewind,
  type GraphRun,
  type GraphRunLimitCode,
  type GraphRunStatus,
  type NodeActivation,
} from "./run-model.js";

export type GraphRunChangeCode =
  | GraphRunLimitCode
  | "duplicate-activation"
  | "unknown-activation"
  | "already-superseded"
  | "duplicate-rewind";

export type GraphRunChange =
  { ok: true; run: GraphRun } | { ok: false; code: GraphRunChangeCode; message: string };

export function isGraphRunTerminal(status: GraphRunStatus): boolean {
  return (GRAPH_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isGraphActivationTerminal(state: GraphActivationState): boolean {
  return (GRAPH_ACTIVATION_TERMINAL_STATES as readonly string[]).includes(state);
}

/** An error text cut to the record's bound (2,000 characters), never split inside a code point. */
export function boundGraphError(text: string): string {
  const max = GRAPH_RUN_BOUNDS.maxErrorChars;
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}

export function graphRunActivation(run: GraphRun, key: string): NodeActivation | undefined {
  return run.activations.find((activation) => activation.key === key);
}

/** Activations that are not superseded, in record order. */
export function liveGraphActivations(run: GraphRun): NodeActivation[] {
  return run.activations.filter((activation) => activation.state !== "superseded");
}

/**
 * Appends one activation, refusing a duplicate key and an overrun of the live
 * cap (200) or of the history bound.
 */
export function appendGraphActivation(run: GraphRun, activation: NodeActivation): GraphRunChange {
  if (graphRunActivation(run, activation.key)) {
    return {
      ok: false,
      code: "duplicate-activation",
      message: "The run already has an activation with this key",
    };
  }
  if (run.activations.length + 1 > GRAPH_RUN_BOUNDS.maxActivationHistory) {
    return {
      ok: false,
      code: "activation-history",
      message: `A run keeps at most ${GRAPH_RUN_BOUNDS.maxActivationHistory} activations, superseded ones included`,
    };
  }
  if (
    activation.state !== "superseded" &&
    liveGraphActivations(run).length + 1 > GRAPH_RUN_BOUNDS.maxActivations
  ) {
    return {
      ok: false,
      code: "activations",
      message: `A run allows at most ${GRAPH_RUN_BOUNDS.maxActivations} activations that are not superseded`,
    };
  }
  return { ok: true, run: { ...run, activations: [...run.activations, activation] } };
}

/** Replaces one activation by key (the caller builds the new value). */
export function replaceGraphActivation(
  run: GraphRun,
  key: string,
  update: (activation: NodeActivation) => NodeActivation,
): GraphRunChange {
  const index = run.activations.findIndex((activation) => activation.key === key);
  if (index < 0) {
    return { ok: false, code: "unknown-activation", message: "The run has no such activation" };
  }
  const current = run.activations[index]!;
  if (current.state === "superseded") {
    return {
      ok: false,
      code: "already-superseded",
      message: "A superseded activation never changes",
    };
  }
  const next = update(current);
  if (next.key !== key) {
    return { ok: false, code: "unknown-activation", message: "An update may not change the key" };
  }
  const activations = [...run.activations];
  activations[index] = next;
  return { ok: true, run: { ...run, activations } };
}

export interface GraphPortQuery {
  nodeId: string;
  port: string;
  /** Only this loop iteration's activations. */
  iteration?: number;
  /** Only this replication branch's activation. */
  branchKey?: string;
}

/**
 * The live artifacts produced on one output port, from activations that are
 * not superseded, in activation-key order (so a fan-in sees the branches in a
 * stable order). Run inputs are addressed by `{nodeId: "$input", port: name}`.
 */
export function liveGraphArtifactsForPort(
  run: GraphRun,
  artifacts: readonly GraphArtifact[],
  query: GraphPortQuery,
): GraphArtifact[] {
  const liveKeys = new Set(liveGraphActivations(run).map((activation) => activation.key));
  return artifacts
    .filter((artifact) => {
      if (artifact.state !== "live" || artifact.runId !== run.id) return false;
      if (artifact.producer.nodeId !== query.nodeId || artifact.producer.port !== query.port) {
        return false;
      }
      const parts = parseGraphActivationKey(artifact.producer.activation);
      if (!parts) return query.iteration === undefined && query.branchKey === undefined;
      if (!liveKeys.has(artifact.producer.activation)) return false;
      if (query.iteration !== undefined && parts.iteration !== query.iteration) return false;
      if (query.branchKey !== undefined && parts.branchKey !== query.branchKey) return false;
      return true;
    })
    .sort((left, right) =>
      left.producer.activation < right.producer.activation
        ? -1
        : left.producer.activation > right.producer.activation
          ? 1
          : 0,
    );
}

export interface GraphLineageDescendants {
  /** Activation keys, the restarted one first, then in record order. */
  activations: string[];
  /** Artifact ids, sorted. */
  artifacts: string[];
}

/**
 * The artifact lineage below `activationKey` (report §8.5): the activation,
 * every artifact it produced, every activation that consumed one of those
 * artifacts, transitively, and every artifact whose lineage reaches one of
 * them. Already-superseded activations and artifacts are left out, so
 * independent branches and earlier attempts stay as they are. Null when the
 * activation does not exist or is already superseded.
 *
 * A restart supersedes more than the lineage: what read a forwarding node
 * (a gate's outlet), what a node's outcome skipped, and the later iterations
 * of a rewound loop. `graphRestartScope` (`run-rewind.ts`) adds those.
 */
export function graphLineageDescendants(
  run: GraphRun,
  artifacts: readonly GraphArtifact[],
  activationKey: string,
): GraphLineageDescendants | null {
  const root = graphRunActivation(run, activationKey);
  if (!root || root.state === "superseded") return null;
  const activationSet = new Set<string>([root.key]);
  const live = artifacts.filter((artifact) => artifact.state === "live");
  // Seeded from what the root produced: a gate or human node's outputs that
  // forward its inputs belong to their upstream producers, which a restart
  // of the forwarding node must keep.
  const artifactSet = new Set<string>(
    live
      .filter((artifact) => artifact.producer.activation === root.key)
      .map((artifact) => artifact.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of live) {
      if (artifactSet.has(artifact.id)) continue;
      if (
        activationSet.has(artifact.producer.activation) ||
        artifact.inputs.some((input) => artifactSet.has(input))
      ) {
        artifactSet.add(artifact.id);
        changed = true;
      }
    }
    for (const activation of run.activations) {
      if (activation.state === "superseded" || activationSet.has(activation.key)) continue;
      const consumed = Object.values(activation.inputs).some((ids) =>
        (Array.isArray(ids) ? ids : [ids]).some((id) => artifactSet.has(id)),
      );
      const produced = Object.values(activation.outputs).some((id) => artifactSet.has(id));
      if (consumed || produced) {
        activationSet.add(activation.key);
        changed = true;
      }
    }
  }
  const order = new Map(run.activations.map((activation, index) => [activation.key, index]));
  return {
    activations: [...activationSet].sort((left, right) =>
      left === root.key ? -1 : right === root.key ? 1 : order.get(left)! - order.get(right)!,
    ),
    artifacts: [...artifactSet].sort(),
  };
}

/**
 * Records a rewind: marks every activation it lists superseded (naming the
 * rewind), and every `items` fan-out cut from an artifact it lists, rewinds
 * the node's loop counter, and appends the rewind. Refuses a
 * 51st rewind, a repeated id, and a rewind that lists an unknown or already
 * superseded activation (a repeated restart request must be a no-op upstream,
 * not a second rewind). The listed artifacts are superseded in the artifact
 * store under the same rewind id.
 */
export function applyGraphRewind(run: GraphRun, rewind: GraphRewind): GraphRunChange {
  if (run.rewinds.some((existing) => existing.id === rewind.id)) {
    return { ok: false, code: "duplicate-rewind", message: "The run already has this rewind" };
  }
  if (run.rewinds.length + 1 > GRAPH_RUN_BOUNDS.maxRewinds) {
    return {
      ok: false,
      code: "rewinds",
      message: `A run allows at most ${GRAPH_RUN_BOUNDS.maxRewinds} rewinds`,
    };
  }
  const targets = new Set(rewind.superseded.activations);
  for (const key of targets) {
    const activation = graphRunActivation(run, key);
    if (!activation) {
      return { ok: false, code: "unknown-activation", message: "The rewind names no activation" };
    }
    if (activation.state === "superseded") {
      return {
        ok: false,
        code: "already-superseded",
        message: "The rewind names an activation that is already superseded",
      };
    }
  }
  const node = run.plan.nodes.find((candidate) => candidate.id === rewind.nodeId);
  const loopIterations =
    node?.loop === undefined
      ? run.loopIterations
      : { ...run.loopIterations, [node.loop]: rewind.iteration };
  // An `items` fan-out cut from a superseded artifact expands again (item 401).
  const fanOuts = supersedeGraphItemFanOuts(
    run.fanOuts,
    rewind.id,
    new Set(rewind.superseded.artifacts),
  );
  return {
    ok: true,
    run: {
      ...run,
      activations: run.activations.map((activation) =>
        targets.has(activation.key)
          ? { ...activation, state: "superseded", supersededBy: rewind.id }
          : activation,
      ),
      rewinds: [...run.rewinds, rewind],
      loopIterations,
      ...(fanOuts ? { fanOuts } : {}),
    },
  };
}
