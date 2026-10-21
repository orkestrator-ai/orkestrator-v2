import type { NodeStatus } from "@orkestrator/protocol/command-nodes";

/**
 * The line a coordinator's context carries about its node's role
 * (docs/architecture/command-nodes.md, "Leaf mode" and "Coordinators").
 *
 * - Leaf mode: the node is subordinate to a named command node; the
 *   coordinator does not act as a cross-node coordinator and handles
 *   messages as an agent on this node would.
 * - Command node: it can work across the connected nodes, creates on its
 *   own node by default, and deletes only on the user's request.
 * - Standalone: nothing to add.
 */
export function coordinatorNodeContext(status: NodeStatus, connectedNodes: number): string | null {
  if (status.mode === "leaf") {
    const controllers = status.controllers.map((entry) => entry.displayName).join(", ");
    return (
      `Node mode: leaf. This node is controlled by ${controllers}, and coordination happens there. ` +
      `You are not a cross-node coordinator here: do not try to control other nodes, create environments elsewhere or transfer files to other nodes (those tools refuse). ` +
      `If you receive a message, handle it as an agent on this node would: act on this node and reply.\n`
    );
  }
  if (status.mode === "command" && connectedNodes > 0) {
    return (
      `Nodes: this is a command node with ${connectedNodes} connected node${connectedNodes === 1 ? "" : "s"} (list_nodes). ` +
      `Create environments on this node with launch_environment unless the user names another node (launch_node_environment). ` +
      `Read and message environments on other nodes with read_node_environment and send_node_message; their agents report back to you by mail. ` +
      `Never delete an environment on your own initiative: only when the user asks, through request_environment_deletion, which the user confirms.\n`
    );
  }
  return null;
}
