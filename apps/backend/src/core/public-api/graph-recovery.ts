import { isGraphRunTerminal, type GraphRun } from "@orkestrator/protocol/graphs/run";
import { graphLaunchRunId } from "../graph-run-launch.js";
import { registerReconciler, type ReconcileFunction } from "./reconciler.js";

/**
 * Restart recovery of `graph.launch` and `graph.cancel` (item 214).
 *
 * A launch derives its run ID from the operation's request key
 * (`graphPublicLaunchRequestId`), so a run with that ID proves the launch.
 * Nothing is ever launched again during recovery; without that proof the
 * operation is `interrupted` and the caller inspects the environment's runs
 * first. A cancel is settled once the run is cancelling or ended.
 */

/** The stage a launch records once its run exists. */
export const GRAPH_LAUNCH_SAVED_STAGE = "graph-launch-saved";

/** The launch service's idempotency key for one public operation. */
export function graphPublicLaunchRequestId(requestKey: string): string {
  return `public:${requestKey}`;
}

/** A launch or cancel result: IDs and states only. */
export function graphRunActionResult(run: GraphRun): Record<string, unknown> {
  return {
    runId: run.id,
    projectId: run.projectId,
    environmentId: run.environmentId ?? null,
    status: run.status,
    template: {
      id: run.plan.template.id,
      revision: run.plan.template.revision,
      name: run.plan.template.name,
    },
  };
}

const reconcileGraph: ReconcileFunction = async (record, context) => {
  if (record.generation === context.generation) return null;
  if (record.result && record.stage === GRAPH_LAUNCH_SAVED_STAGE) {
    return { state: "succeeded", stage: "completed", result: record.result };
  }
  const runs = context.command.storage.graphRuns;
  if (record.action === "graph.launch") {
    const projectId = record.resources.projectId;
    const run = projectId
      ? await runs.getGraphRun(
          graphLaunchRunId(projectId, graphPublicLaunchRequestId(record.requestKey)),
        )
      : null;
    if (run) {
      // The run record proves the launch; its supervisor carries on after the restart.
      return {
        state: "succeeded",
        stage: "completed",
        resources: {
          projectId: run.projectId,
          ...(run.environmentId ? { environmentId: run.environmentId } : {}),
        },
        result: graphRunActionResult(run),
      };
    }
  } else {
    const runId = record.scope.startsWith("graph-run:") ? record.scope.slice(10) : undefined;
    const run = runId ? await runs.getGraphRun(runId) : null;
    if (run && (run.status === "cancelling" || isGraphRunTerminal(run.status))) {
      return { state: "succeeded", stage: "completed", result: graphRunActionResult(run) };
    }
  }
  return {
    state: "interrupted",
    error: {
      code: "run-interrupted",
      message:
        "The backend restarted during this graph action; its effect is not confirmed. Inspect the run with graph status before issuing a new request",
    },
  };
};

for (const action of ["graph.launch", "graph.cancel"] as const) {
  registerReconciler(action, reconcileGraph);
}
