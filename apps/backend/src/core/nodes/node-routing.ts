import { randomUUID } from "node:crypto";
import { isNodeReadCommand } from "@orkestrator/protocol/command-nodes";

import type { BackendId } from "@orkestrator/protocol/federation";

import { NodeOutcomeUnknownError, NodeUnavailableError } from "./node-link.js";

/**
 * Node-qualified command routing for the portal: a client names the node and
 * the command node forwards the command to its owner over the node link.
 *
 * Administrative commands never cross: they belong to the node's own user
 * (token rotation, attachment, grants) or would let one node reach past
 * another (registry commands of a node in leaf mode). The same list applies
 * to client grants and to the relay.
 *
 * A write whose answer was lost is recorded as outcome-unknown against the
 * node and never resubmitted automatically.
 */

export const NODE_EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
  // Attachment and grants belong to the node and its controllers.
  "attach_controller",
  "detach_controller",
  "detach_controller_here",
  "allow_controller",
  "list_controllers",
  "sync_controller_settings",
  "set_command_node_enabled",
  "create_client_grant",
  "renew_client_grant",
  "revoke_client_grant",
  // A subordinate's suspended registry is never reachable through it.
  "list_nodes",
  "add_node",
  "update_node",
  "forget_node",
  "discard_node_detach",
  "reconnect_node",
  "import_desktop_connections",
  "preview_command_handover",
  "hand_over_command",
  "accept_command_handover",
  "list_node_ssh_prompts",
  "answer_node_ssh_prompt",
  "probe_node_host_key",
  "trust_node_host_key",
  "invoke_on_node",
  // The outbox belongs to the command node it is for; decisions to the user.
  "collect_node_outbox",
  "ack_node_outbox",
  "create_node_action_request",
  "list_node_action_requests",
  "resolve_node_action_request",
  // Transfers and comparisons are run by the command node, not through it.
  "transfer_node_files",
  "list_node_transfers",
  "compare_project_files",
  "get_node_summaries",
  "get_portal_layout",
  "update_portal_layout",
  "open_node_workspace",
  "renew_node_workspace",
  "close_node_workspace",
  // Secrets of the node itself.
  "get_gateway_token_settings",
  "set_gateway_token",
  "rotate_control_mcp_token",
  "get_control_mcp_settings",
]);

export function isWorkspaceExcludedCommand(command: string): boolean {
  return (
    isNodeExcludedCommand(command) ||
    [
      "deliver_node_mail",
      "record_node_environment_origin",
      "stat_node_file",
      "read_node_file",
      "begin_node_file_write",
      "append_node_file_write",
      "commit_node_file_write",
      "abort_node_file_write",
      "read_env_values",
      "apply_env_keys",
      "fingerprint_project_files",
      "get_project_seed_files",
    ].includes(command)
  );
}

export function isNodeExcludedCommand(command: string): boolean {
  return NODE_EXCLUDED_COMMANDS.has(command);
}

/** Reads safe to repeat while reconnecting, shared with summary invalidation. */
export { isNodeReadCommand as isReadCommand } from "@orkestrator/protocol/command-nodes";

export interface NodeOutcomeRecord {
  outcomeId: string;
  nodeId: BackendId;
  command: string;
  requestKey: string;
  recordedAt: string;
}

export const MAX_NODE_OUTCOMES = 200;

/**
 * Outcome-unknown records for routed writes. Kept in memory and in the
 * command node's store; dismissed only by the user.
 */
export class NodeOutcomeLedger {
  private records: NodeOutcomeRecord[] = [];

  constructor(
    private readonly persistence?: {
      load(): Promise<unknown>;
      save(records: NodeOutcomeRecord[]): Promise<void>;
    },
  ) {}

  async restore(): Promise<void> {
    const raw = await this.persistence?.load().catch(() => null);
    if (!Array.isArray(raw)) return;
    this.records = raw
      .filter(
        (entry): entry is NodeOutcomeRecord =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as NodeOutcomeRecord).outcomeId === "string" &&
          typeof (entry as NodeOutcomeRecord).nodeId === "string" &&
          typeof (entry as NodeOutcomeRecord).command === "string",
      )
      .slice(-MAX_NODE_OUTCOMES);
  }

  list(nodeId?: string): NodeOutcomeRecord[] {
    return this.records.filter((record) => !nodeId || record.nodeId === nodeId);
  }

  async record(
    entry: Omit<NodeOutcomeRecord, "outcomeId" | "recordedAt">,
  ): Promise<NodeOutcomeRecord> {
    const record: NodeOutcomeRecord = {
      ...entry,
      outcomeId: randomUUID(),
      recordedAt: new Date().toISOString(),
    };
    this.records = [...this.records, record].slice(-MAX_NODE_OUTCOMES);
    await this.persistence?.save(this.records).catch(() => undefined);
    return record;
  }

  async dismiss(outcomeId: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.outcomeId !== outcomeId);
    if (this.records.length === before) return false;
    await this.persistence?.save(this.records).catch(() => undefined);
    return true;
  }
}

export interface RoutableLink {
  readonly connected: boolean;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export type RoutedResult<T> =
  | { outcome: "ok"; result: T }
  | { outcome: "unknown"; requestKey: string; outcomeId: string };

/**
 * Forward one command to its node. Writes are refused while the node is not
 * connected (so nothing is queued silently); an answer lost in flight is
 * recorded, not retried.
 */
export async function routeToNode<T>(input: {
  nodeId: BackendId;
  link: RoutableLink | null;
  command: string;
  args: Record<string, unknown>;
  requestKey?: string;
  outcomes: NodeOutcomeLedger;
}): Promise<RoutedResult<T>> {
  if (isNodeExcludedCommand(input.command)) {
    throw new Error(`${input.command} cannot be run on another node from here.`);
  }
  if (!input.link || !input.link.connected) {
    throw new NodeUnavailableError(
      isNodeReadCommand(input.command)
        ? "That node is not connected; its last-known state is shown."
        : "That node is not connected, so changes to it are disabled.",
    );
  }
  try {
    return { outcome: "ok", result: await input.link.invoke<T>(input.command, input.args) };
  } catch (error) {
    if (error instanceof NodeOutcomeUnknownError && !isNodeReadCommand(input.command)) {
      const requestKey = input.requestKey ?? randomUUID();
      const record = await input.outcomes.record({
        nodeId: input.nodeId,
        command: input.command,
        requestKey,
      });
      return { outcome: "unknown", requestKey, outcomeId: record.outcomeId };
    }
    throw error;
  }
}
