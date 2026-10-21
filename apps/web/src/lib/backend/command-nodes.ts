import type {
  NodeListResult,
  NodeRoute,
  NodeStatus,
  NodeView,
} from "@orkestrator/protocol/command-nodes";
import { parseNodeRefusal } from "@orkestrator/protocol/command-nodes";
import { portalInvoke as invoke } from "@/lib/portal/portal-transport";

/** A node command's error for display: a refusal's message without its code prefix. */
export function nodeErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return parseNodeRefusal(text)?.message ?? text;
}

/**
 * Command-node commands of the command node this client is connected to,
 * over the portal channel (so they reach it even while the window's
 * workspace is on a leaf). The registry, routes and the credentials of
 * other nodes live in that backend; the client only ever sees `NodeView`s,
 * never a node's token.
 */

export async function getNodeStatus(): Promise<NodeStatus> {
  return invoke<NodeStatus>("get_node_status");
}

export async function setCommandNodeEnabled(enabled: boolean): Promise<NodeStatus> {
  return invoke<NodeStatus>("set_command_node_enabled", { enabled });
}

export async function listNodes(): Promise<NodeListResult> {
  return invoke<NodeListResult>("list_nodes");
}

/** Register a node. The token is sent to this backend once and kept there. */
export async function addNode(input: {
  routes: NodeRoute[];
  token: string;
  displayName?: string;
}): Promise<NodeView> {
  return invoke<NodeView>("add_node", { ...input });
}

export async function updateNode(input: {
  nodeId: string;
  enabled?: boolean;
  routes?: NodeRoute[];
  routeOrder?: string[];
  token?: string;
}): Promise<NodeView> {
  return invoke<NodeView>("update_node", { ...input });
}

export async function reconnectNode(nodeId: string): Promise<NodeView> {
  return invoke<NodeView>("reconnect_node", { nodeId });
}

/** Forget a node here. Nothing on that node is stopped or deleted. */
export async function forgetNode(
  nodeId: string,
  options: { withoutDetach?: boolean } = {},
): Promise<{ forgotten: boolean; detached: boolean }> {
  return invoke("forget_node", { nodeId, ...options });
}

export async function discardNodeDetach(nodeId: string): Promise<{ discarded: boolean }> {
  return invoke("discard_node_detach", { nodeId });
}

/** Detach a command node from this node (leaf side). It may not re-attach until allowed. */
export async function detachControllerHere(controllerId: string): Promise<{ detached: boolean }> {
  return invoke("detach_controller_here", { controllerId });
}

export async function allowController(controllerId: string): Promise<{ allowed: boolean }> {
  return invoke("allow_controller", { controllerId });
}

export async function answerNodeSshPrompt(
  promptId: string,
  answer: string | null,
): Promise<{ answered: boolean }> {
  return invoke(
    "answer_node_ssh_prompt",
    answer === null ? { promptId, cancel: true } : { promptId, answer },
  );
}

export async function probeNodeHostKey(input: { destination: string; sshPort?: number }): Promise<{
  probeId: string;
  destination: string;
  fingerprints: Array<{ type: string; fingerprint: string }>;
}> {
  return invoke("probe_node_host_key", { ...input });
}

export async function trustNodeHostKey(probeId: string): Promise<{ added: number }> {
  return invoke("trust_node_host_key", { probeId });
}

export function listNodeSshPrompts(): Promise<
  Array<{
    promptId: string;
    nodeId: string;
    kind: string;
    message: string;
    state: "open" | "closed";
  }>
> {
  return invoke("list_node_ssh_prompts");
}
