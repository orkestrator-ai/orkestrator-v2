/**
 * Where a link to a coordinator's work goes: a worker's tab, a build, a Multi
 * Review, a graph run or a pull request, on this machine or on another node.
 *
 * Mail tiles and the workers' prompts banner open these targets through
 * `openCoordinatorWorkTarget`; a realm workspace receives the local part of a
 * remote target as its `workTarget`.
 */
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";

export type LocalWorkTarget = Exclude<
  CoordinatorWorkTarget,
  { type: "remote" } | { type: "pull-request" }
>;

export type CoordinatorWorkTarget =
  /** A worker environment on this machine, at the delegated tab when known. */
  | { type: "worker-tab"; projectId: string; environmentId: string; tabId?: string }
  /** A build pipeline's tab; the environment may not exist yet. */
  | { type: "build"; projectId: string; pipelineId: string; environmentId?: string }
  | { type: "review"; projectId: string; environmentId: string; workflowId: string }
  | { type: "graph-run"; projectId: string; environmentId: string; runId: string; title?: string }
  | { type: "pull-request"; url: string }
  /** Work on another node: its environment, through that node's workspace. */
  | {
      type: "remote";
      nodeId: string;
      projectId: string;
      environmentId: string;
      title: string;
      workTarget?: LocalWorkTarget;
    };

/**
 * The target for one worker tab named by a notice or a waiting prompt, or null
 * when this client cannot reach it: an environment it does not know (deleted, or
 * on another node with no `nodeId` to say so), one being deleted, or a node that
 * is not connected.
 */
export function workerTabTarget(
  worker: { environmentId: string; tabId?: string; nodeId?: string; title: string },
  lookup: {
    environments: readonly { id: string; projectId: string; deletionRequestedAt?: string }[];
    nodes: readonly Pick<NodeSummary, "nodeId" | "available" | "environments">[];
  },
): CoordinatorWorkTarget | null {
  const { environmentId, tabId, nodeId, title } = worker;
  if (nodeId) {
    const node = lookup.nodes.find((item) => item.nodeId === nodeId);
    const environment = node?.available
      ? node.environments.find((item) => item.ref.environmentId === environmentId)
      : undefined;
    if (!environment || environment.deleting) return null;
    const projectId = environment.projectId;
    return {
      type: "remote",
      nodeId,
      projectId,
      environmentId,
      title,
      workTarget: { type: "worker-tab", projectId, environmentId, ...(tabId ? { tabId } : {}) },
    };
  }
  const environment = lookup.environments.find((item) => item.id === environmentId);
  if (!environment || environment.deletionRequestedAt) return null;
  return {
    type: "worker-tab",
    projectId: environment.projectId,
    environmentId,
    ...(tabId ? { tabId } : {}),
  };
}
