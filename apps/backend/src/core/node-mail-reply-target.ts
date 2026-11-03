import {
  COORDINATOR_MAIL_ADDRESS,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";

type JsonRecord = Record<string, unknown>;

/**
 * Where a coordinator's reply to mail from another node goes, read from the
 * message's sender: up through this leaf's outbox for a command node's
 * coordinator, otherwise back across the node link to the agent or to that
 * node's coordinator address (which survives its main being replaced).
 */
export function nodeMailReplyTarget(
  from: unknown,
):
  | { kind: "command-node" }
  | { kind: "node"; nodeId: string; toEnvironmentId: string; toTabId?: string }
  | null {
  if (!from || typeof from !== "object" || Array.isArray(from)) return null;
  const sender = from as JsonRecord;
  if (
    sender.kind !== "node" ||
    typeof sender.nodeId !== "string" ||
    typeof sender.environmentId !== "string" ||
    typeof sender.tabId !== "string"
  )
    return null;
  if (sender.role === "coordinator") return { kind: "command-node" };
  if (coordinatorIdFromRuntimeId(sender.environmentId)) {
    return { kind: "node", nodeId: sender.nodeId, toEnvironmentId: COORDINATOR_MAIL_ADDRESS };
  }
  return {
    kind: "node",
    nodeId: sender.nodeId,
    toEnvironmentId: sender.environmentId,
    toTabId: sender.tabId,
  };
}
