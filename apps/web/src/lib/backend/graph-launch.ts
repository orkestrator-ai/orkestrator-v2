import type {
  GraphLaunchOptions,
  GraphLaunchRequest,
  GraphLaunchResult,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import { type AccountMachine } from "./agent-accounts";
import { graphsOn } from "@/lib/node-scope/domains/graphs";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * Graph launches (item 214): what the launch dialog shows for a template,
 * and the launch itself. Both go to the machine that owns the project. A
 * refused launch rejects with the backend's message and a `code` from
 * `GRAPH_LAUNCH_ERROR_CODES`.
 */

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createGraphLaunchApi(client: BackendClient) {
  function getGraphLaunchOptions(
    input: {
      ref: GraphTemplateRef;
      projectId: string;
      environmentId?: string;
      create?: "worktree" | "container";
    },
    machine?: AccountMachine,
  ): Promise<GraphLaunchOptions> {
    return graphsOn(client, machine).graph_launch_options({ ...input });
  }

  function launchGraphRun(
    request: GraphLaunchRequest,
    machine?: AccountMachine,
  ): Promise<GraphLaunchResult> {
    return graphsOn(client, machine).graph_run_launch({ ...request });
  }

  return { getGraphLaunchOptions, launchGraphRun };
}

export type GraphLaunchApi = ReturnType<typeof createGraphLaunchApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const { getGraphLaunchOptions, launchGraphRun } = createGraphLaunchApi(commandBackendClient);
