import type { NodeStatus } from "@orkestrator/protocol/command-nodes";

/**
 * The line a coordinator's context carries about its node's role
 * (docs/architecture/command-nodes.md, "Leaf mode" and "Coordinators").
 *
 * - Leaf mode: the node is subordinate to a named command node; the
 *   coordinator does not act as a cross-node coordinator and handles
 *   messages as an agent on this node would.
 * - Command node: it can work across the connected nodes, creates on the node
 *   the user names, else on its own unless load or OS says otherwise, and
 *   deletes only on the user's request.
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
      `Every environment and workflow tool takes an optional nodeId and works on that node's copy of this project exactly as on this one: launch_environment, launch_job, send_prompt_to_tab, send_message, the tab reads, start_build_pipeline and the Multi Review tools. ` +
      `A node the user names always wins. Otherwise work on this node unless load or OS gives a clear reason to move: list_nodes reports each machine's OS and its average CPU and RAM over 5 minutes, 1 hour and 24 hours, so pick a machine with the OS the work needs and prefer a less loaded one, weighing the recent windows most. An average whose coveredSeconds is below its windowSeconds rests on less history, and an unavailable machine's load is unknown, not idle. For another node take baseBranch and baseCommit from get_launch_options with its nodeId. ` +
      `list_environments shows this project's environments on the other nodes too; calls you are told to make about work on another node already carry its nodeId. ` +
      `A node without a copy of this project needs one first: ask the user with request_project_on_node. ` +
      `Never delete an environment on your own initiative: only when the user asks, through request_environment_deletion, which the user confirms.\n`
    );
  }
  return null;
}
