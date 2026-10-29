import type {
  GraphLaunchOptions,
  GraphLaunchRequest,
  GraphLaunchResult,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import { machineInvoke, type AccountMachine } from "./agent-accounts";

/**
 * Graph launches (item 214): what the launch dialog shows for a template,
 * and the launch itself. Both go to the machine that owns the project. A
 * refused launch rejects with the backend's message and a `code` from
 * `GRAPH_LAUNCH_ERROR_CODES`.
 */

export function getGraphLaunchOptions(
  input: {
    ref: GraphTemplateRef;
    projectId: string;
    environmentId?: string;
    create?: "worktree" | "container";
  },
  machine?: AccountMachine,
): Promise<GraphLaunchOptions> {
  return machineInvoke(machine, "graph_launch_options", { ...input });
}

export function launchGraphRun(
  request: GraphLaunchRequest,
  machine?: AccountMachine,
): Promise<GraphLaunchResult> {
  return machineInvoke(machine, "graph_run_launch", { ...request });
}
