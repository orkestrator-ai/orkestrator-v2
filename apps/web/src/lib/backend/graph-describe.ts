import type {
  GraphDescribeJobView,
  GraphDescribeStartInput,
} from "@orkestrator/protocol/graphs/describe";
import { invoke } from "@/lib/native/backend";

/**
 * "Describe a graph" (item 215): the backend owns each environment's job, so
 * the designer only starts, reads, cancels and dismisses it. A refused call
 * rejects with the backend's message (an invalid request, a stopped
 * environment, an agent without result tools, a job already running).
 */

export function startGraphDescribe(input: GraphDescribeStartInput): Promise<GraphDescribeJobView> {
  return invoke("graph_describe_start", { ...input });
}

/** The environment's latest job, or null. */
export function getGraphDescribeStatus(
  environmentId: string,
): Promise<GraphDescribeJobView | null> {
  return invoke("graph_describe_status", { environmentId });
}

export function cancelGraphDescribe(environmentId: string): Promise<GraphDescribeJobView | null> {
  return invoke("graph_describe_cancel", { environmentId });
}

/** Forgets a finished job once its draft was opened or the user dismissed it. */
export function dismissGraphDescribe(
  environmentId: string,
  jobId: string,
): Promise<{ dismissed: boolean }> {
  return invoke("graph_describe_dismiss", { environmentId, jobId });
}
