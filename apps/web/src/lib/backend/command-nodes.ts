import type {
  NodeListResult,
  NodeRoute,
  NodeStatus,
  NodeView,
} from "@orkestrator/protocol/command-nodes";
import { parseNodeRefusal } from "@orkestrator/protocol/command-nodes";
import { NO_ARGS, nodesApi } from "@/lib/node-scope/domains/nodes";
import { portalBackendClient } from "./client";

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
 *
 * These always mean the command node, so the file has no `createXApi(client)`
 * factory (plan item 3002): no scope ever wired one in, and it was removed
 * (7571 task 14).
 */
const nodes = () => nodesApi(portalBackendClient);

export async function getNodeStatus(): Promise<NodeStatus> {
  return nodes().get_node_status(NO_ARGS);
}

export async function setCommandNodeEnabled(enabled: boolean): Promise<NodeStatus> {
  return nodes().set_command_node_enabled({ enabled });
}

export async function listNodes(): Promise<NodeListResult> {
  return nodes().list_nodes(NO_ARGS);
}

/** Register a node. The token is sent to this backend once and kept there. */
export async function addNode(input: {
  routes: NodeRoute[];
  token: string;
  displayName?: string;
}): Promise<NodeView> {
  return nodes().add_node({ ...input });
}

export async function updateNode(input: {
  nodeId: string;
  enabled?: boolean;
  routes?: NodeRoute[];
  routeOrder?: string[];
  token?: string;
}): Promise<NodeView> {
  return nodes().update_node({ ...input });
}

export async function reconnectNode(nodeId: string): Promise<NodeView> {
  return nodes().reconnect_node({ nodeId });
}

/** Forget a node here. Nothing on that node is stopped or deleted. */
export async function forgetNode(
  nodeId: string,
  options: { withoutDetach?: boolean } = {},
): Promise<{ forgotten: boolean; detached: boolean }> {
  return nodes().forget_node({ nodeId, ...options });
}

export async function discardNodeDetach(nodeId: string): Promise<{ discarded: boolean }> {
  return nodes().discard_node_detach({ nodeId });
}

/** Detach a command node from this node (leaf side). It may not re-attach until allowed. */
export async function detachControllerHere(controllerId: string): Promise<{ detached: boolean }> {
  return nodes().detach_controller_here({ controllerId });
}

export async function allowController(controllerId: string): Promise<{ allowed: boolean }> {
  return nodes().allow_controller({ controllerId });
}

export async function answerNodeSshPrompt(
  promptId: string,
  answer: string | null,
): Promise<{ answered: boolean }> {
  return nodes().answer_node_ssh_prompt(
    answer === null ? { promptId, cancel: true } : { promptId, answer },
  );
}

export async function probeNodeHostKey(input: { destination: string; sshPort?: number }): Promise<{
  probeId: string;
  destination: string;
  fingerprints: Array<{ type: string; fingerprint: string }>;
}> {
  const probe = await nodes().probe_node_host_key({ ...input });
  return { ...probe, fingerprints: [...probe.fingerprints] };
}

export async function trustNodeHostKey(probeId: string): Promise<{ added: number }> {
  return nodes().trust_node_host_key({ probeId });
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
  return nodes().list_node_ssh_prompts(NO_ARGS) as Promise<
    Array<{
      promptId: string;
      nodeId: string;
      kind: string;
      message: string;
      state: "open" | "closed";
    }>
  >;
}
