/**
 * Loop progress (plan P2.3, P2.6; report §4.4): when a loop's iteration is
 * over, whether the loop is done, and when it moves to the next iteration.
 *
 * Pure. An iteration is *settled* when every member position (every branch
 * of a replicated member) at that iteration has a terminal activation. A
 * settled loop is *done* when
 *
 * - it reached `maxIterations`, or
 * - no member ran in the iteration (all skipped: the loop was not entered,
 *   for example behind an untaken gate outlet), or
 * - its `until` holds over the iteration's outputs (`<member>.<port>` roots;
 *   a replicated member's root is the list of its branches' values; an
 *   output not produced is unknown, and unknown is not true).
 *
 * Otherwise the run moves to the next iteration (`run.loopIterations`). The
 * done state is not stored: it follows from immutable activations and
 * artifacts, so every pass derives the same answer. Restarts inside a loop
 * (item 210) rewind `loopIterations` and supersede the later activations.
 */
import { evaluateGraphPredicate } from "@orkestrator/protocol/graphs/predicates";
import { isGraphActivationTerminal } from "@orkestrator/protocol/graphs/run";
import type { GraphPlanLoop } from "@orkestrator/protocol/graphs/compile";
import { graphPredicatePaths } from "./graph-run-ready-set.js";
import type { GraphRunView } from "./graph-run-view.js";

export type GraphLoopState =
  | { state: "running" }
  | { state: "done" }
  | { state: "next"; iteration: number }
  /** Settled, but `until` needs these artifact values first. */
  | { state: "needs-values"; ids: string[] };

/** Where one loop stands at its current iteration. */
export function graphLoopState(view: GraphRunView, loop: GraphPlanLoop): GraphLoopState {
  const iteration = view.iteration(loop.id);
  let ran = false;
  for (const memberId of loop.members) {
    const member = view.node(memberId);
    for (const branchKey of view.branchKeysOf(member)) {
      const activation = view.latestAt(memberId, iteration, branchKey);
      if (!activation || !isGraphActivationTerminal(activation.state)) return { state: "running" };
      if (activation.state !== "skipped") ran = true;
    }
  }
  if (!ran || iteration >= loop.maxIterations) return { state: "done" };
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  const roots = new Set(
    graphPredicatePaths(loop.until).flatMap((path) => {
      const [node, port] = path.split(".");
      return node !== undefined && port !== undefined ? [`${node}.${port}`] : [];
    }),
  );
  for (const root of roots) {
    const [nodeId, port] = root.split(".") as [string, string];
    if (!loop.members.includes(nodeId)) continue;
    const member = view.node(nodeId);
    const branches = view.branchKeysOf(member);
    const read = (branchKey: string | undefined): { value: unknown } | null => {
      const id = view.latestAt(nodeId, iteration, branchKey)?.outputs[port];
      if (id === undefined) return { value: undefined };
      const loaded = view.values.get(id);
      if (!loaded) {
        missing.push(id);
        return null;
      }
      return loaded;
    };
    if (view.branchesOf(member) === null) {
      const loaded = read(undefined);
      if (loaded && loaded.value !== undefined) values[root] = loaded.value;
    } else {
      const loaded = branches.map(read);
      if (loaded.every((entry) => entry !== null)) {
        values[root] = loaded.flatMap((entry) =>
          entry!.value === undefined ? [] : [entry!.value],
        );
      }
    }
  }
  if (missing.length > 0) return { state: "needs-values", ids: missing };
  const decision = evaluateGraphPredicate(loop.until, {
    values,
    params: view.run.bindings.params,
    run: { iteration },
  });
  return decision.value ? { state: "done" } : { state: "next", iteration: iteration + 1 };
}
