/**
 * Loop progress (plan P2.3, P2.6; report §4.4): when a loop's iteration is
 * over, whether the loop is done, and when it moves to the next iteration.
 *
 * Pure. An iteration is *settled* when every member position (every branch
 * of a replicated member) at that iteration has a terminal activation. A
 * settled loop is *done* when
 *
 * - no member ran in the iteration (all skipped: the loop was not entered,
 *   for example behind an untaken gate outlet): reason `not-entered`;
 * - its `until` holds over the iteration's outputs (`<member>.<port>` roots;
 *   a replicated member's root is the list of its branches' values; an
 *   output not produced is unknown, and unknown is not true): `converged`;
 * - it reached `maxIterations` without `until` holding: `bound`.
 *
 * Otherwise the run moves to the next iteration (`run.loopIterations`). The
 * iteration is part of every member activation's key
 * (`node#iter=2#attempt=1`), and a carry reads the producer's latest live
 * activation of the previous iteration.
 *
 * **Stopping at the bound** is an outcome, not a failure: the loop is done,
 * and everything after it reads the last iteration's artifacts, exactly as
 * after convergence. A template that must treat non-convergence differently
 * gates after the loop on the artifact its `until` reads (for §9.2,
 * `verify.verdict.complete`), sending the unconverged case to a person or a
 * failure branch. {@link graphLoopState} names the reason, so the run view
 * (211) can show "stopped at 3 of 3" without re-deriving it.
 *
 * The done state is not stored: it follows from immutable activations and
 * artifacts, so every pass derives the same answer. Restarts inside a loop
 * (item 210) rewind `loopIterations` and supersede the later activations.
 */
import { evaluateGraphPredicate } from "@orkestrator/protocol/graphs/predicates";
import { isGraphActivationTerminal } from "@orkestrator/protocol/graphs/run";
import type { GraphPlanLoop } from "@orkestrator/protocol/graphs/compile";
import { graphPlanScopeParams } from "@orkestrator/protocol/graphs/subgraphs";
import { graphPredicatePaths } from "./graph-run-ready-set.js";
import type { GraphRunView } from "./graph-run-view.js";

/** Why a loop is done: `until` held, it reached `maxIterations`, or nothing in it ran. */
export type GraphLoopDoneReason = "converged" | "bound" | "not-entered";

export type GraphLoopState =
  | { state: "running" }
  | { state: "done"; reason: GraphLoopDoneReason; iteration: number }
  | { state: "next"; iteration: number }
  /** Settled, but `until` needs these artifact values first. */
  | { state: "needs-values"; ids: string[] };

/** Where one loop stands at its current iteration. */
export function graphLoopState(view: GraphRunView, loop: GraphPlanLoop): GraphLoopState {
  const iteration = view.iteration(loop.id);
  let ran = false;
  for (const memberId of loop.members) {
    const member = view.node(memberId);
    for (const branchKey of view.branchKeysAt(member, iteration)) {
      const activation = view.latestAt(memberId, iteration, branchKey);
      if (!activation || !isGraphActivationTerminal(activation.state)) return { state: "running" };
      if (activation.state !== "skipped") ran = true;
    }
  }
  if (!ran) return { state: "done", reason: "not-entered", iteration };
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
    const branches = view.branchKeysAt(member, iteration);
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
    if (view.branchesAt(member, iteration) === null) {
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
    params: graphPlanScopeParams(view.run.plan, loop.subgraph, view.run.bindings.params),
    run: { iteration },
  });
  if (decision.value) return { state: "done", reason: "converged", iteration };
  if (iteration >= loop.maxIterations) return { state: "done", reason: "bound", iteration };
  return { state: "next", iteration: iteration + 1 };
}
