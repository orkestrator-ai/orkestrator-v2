import type {
  GraphDescribeJobView,
  GraphDescribeStartInput,
} from "@orkestrator/protocol/graphs/describe";
import { graphs } from "@/lib/node-scope/domains/graphs";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * "Describe a graph" (item 215): the backend owns each environment's job, so
 * the designer only starts, reads, cancels and dismisses it. A refused call
 * rejects with the backend's message (an invalid request, a stopped
 * environment, an agent without result tools, a job already running).
 */

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createGraphDescribeApi(client: BackendClient) {
  const api = () => graphs(client);

  function startGraphDescribe(input: GraphDescribeStartInput): Promise<GraphDescribeJobView> {
    return api().graph_describe_start({ ...input });
  }

  /** The environment's latest job, or null. */
  function getGraphDescribeStatus(environmentId: string): Promise<GraphDescribeJobView | null> {
    return api().graph_describe_status({ environmentId });
  }

  function cancelGraphDescribe(environmentId: string): Promise<GraphDescribeJobView | null> {
    return api().graph_describe_cancel({ environmentId });
  }

  /** Forgets a finished job once its draft was opened or the user dismissed it. */
  function dismissGraphDescribe(
    environmentId: string,
    jobId: string,
  ): Promise<{ dismissed: boolean }> {
    return api().graph_describe_dismiss({ environmentId, jobId });
  }

  return { startGraphDescribe, getGraphDescribeStatus, cancelGraphDescribe, dismissGraphDescribe };
}

export type GraphDescribeApi = ReturnType<typeof createGraphDescribeApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  startGraphDescribe,
  getGraphDescribeStatus,
  cancelGraphDescribe,
  dismissGraphDescribe,
} = createGraphDescribeApi(commandBackendClient);
