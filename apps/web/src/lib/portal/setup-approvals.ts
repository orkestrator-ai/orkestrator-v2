import { portalInvoke } from "./portal-transport";

/** Mirrors `nodes/node-setup-approvals.ts` on the backend. */
export type SetupApprovalNodeStatus =
  "approved" | "no-project" | "not-connected" | "outcome-unknown" | "needs-update" | "failed";

export interface SetupApprovalNodeResult {
  nodeId: string;
  nodeName: string;
  status: SetupApprovalNodeStatus;
  projectIds: string[];
  error?: string;
}

/**
 * Approve a project's setup commands on every machine the command node
 * controls that has the project. `nodeId` and `projectId` name the copy the
 * user is looking at; the command node finds the others by repository.
 */
export function approveSetupCommandsOnNodes(
  nodeId: string,
  projectId: string,
  hash: string,
): Promise<{ nodes: SetupApprovalNodeResult[] }> {
  return portalInvoke("approve_setup_commands_on_nodes", { nodeId, projectId, hash });
}
