import type { GraphLaunchResult } from "@orkestrator/protocol/graphs/launch";
import { toast } from "sonner";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";

/**
 * Shows a run that was just launched (item 214): the one place every launch
 * surface in the app goes through, so it can later route through item 213's
 * `requestGraphRunView` instead.
 *
 * The `graph-run` tab names its run only, so it opens in the environment the
 * launch came from even when the run provisions a new one. A launch with no
 * environment to open a tab in (a Kanban card) says where the run is instead;
 * its environment's Graphs list shows it.
 */
export function openLaunchedGraphRun(input: {
  result: GraphLaunchResult;
  /** The environment's `createTab`, when the launch came from one. */
  createTab?: ((type: CreatableTabType, options?: CreateTabOptions) => boolean) | null;
  /** The run's environment name, when it already has one. */
  environmentName?: string;
}): boolean {
  const { result } = input;
  const title = result.template.name;
  if (input.createTab) {
    const opened = input.createTab("graph-run", { graphRun: { runId: result.runId, title } });
    if (opened) return true;
  }
  toast.success(`Started ${title}`, {
    description: result.environmentId
      ? `It runs in ${input.environmentName ?? "its environment"}; open it from that environment's Graphs list.`
      : "It starts in a new environment once that is created.",
  });
  return false;
}
