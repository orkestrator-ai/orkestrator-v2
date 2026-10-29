import type { GraphLaunchResult } from "@orkestrator/protocol/graphs/launch";
import { toast } from "sonner";
import { requestGraphRunView } from "@/lib/graph-run-navigation";

/**
 * Shows a run that was just launched (item 214): every launch surface in the
 * app goes through here, and here through item 213's `requestGraphRunView`,
 * the same path Mock run uses.
 *
 * The `graph-run` tab names its run only, so it opens in the environment the
 * launch came from (`environmentId`), even when the run provisions a new
 * one; a launch from outside an environment (a Kanban card) targets the
 * run's own environment when it has one. When that environment is not on
 * screen the request waits for it, and a toast says where the run is.
 */
export function openLaunchedGraphRun(input: {
  result: GraphLaunchResult;
  /** The environment the launch came from, when it came from one. */
  environmentId?: string;
  /** The run's environment name, when it already has one. */
  environmentName?: string;
}): boolean {
  const { result } = input;
  const title = result.template.name;
  const target = input.environmentId ?? result.environmentId;
  if (
    target &&
    requestGraphRunView({
      runId: result.runId,
      projectId: result.projectId,
      environmentId: target,
      mock: false,
      title,
    })
  ) {
    return true;
  }
  toast.success(`Started ${title}`, {
    description: result.environmentId
      ? `It runs in ${input.environmentName ?? "its environment"}; its tab opens there.`
      : "It starts in a new environment once that is created; open it from the Graphs list.",
  });
  return false;
}
