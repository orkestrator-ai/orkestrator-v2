import { randomUUID } from "node:crypto";
import { isNodeReadCommand } from "@orkestrator/protocol/command-nodes";

import type { BackendId } from "@orkestrator/protocol/federation";

import {
  NodeOutcomeUnknownError,
  NodeUnavailableError,
  type ContractEnvelope,
} from "./node-link.js";

/**
 * Node-qualified command routing for the portal: a client names the node and
 * the command node forwards the command to its owner over the node link.
 *
 * Commands in {@link NODE_ROUTING_EXCLUDED_COMMANDS} are never routed: they
 * belong to the node's own user (token rotation, attachment, grants) or would
 * let one node reach past another (registry commands of a node in leaf mode).
 * The routed call runs with the link's full credential, so this list is not
 * the workspace grant scope: grants and the relay admit only `access:
 * "workspace"` definitions (`admitsWorkspaceCommand`,
 * `workspace-grant-scope.ts`, plan item 7012).
 *
 * A write whose answer was lost is recorded as outcome-unknown against the
 * node and never resubmitted automatically.
 */

export const NODE_ROUTING_EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
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
  // The command node's own fan-out of a user's setup approval: run where the
  // user is, never on their behalf through a link, grant or relay.
  "approve_setup_commands_on_nodes",
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
  "return_node_outbox_mail",
  // Kanban sync runs over the link between a command node and its leaf only.
  "apply_ticket_sync",
  "get_ticket_sync_cursor",
  "collect_ticket_sync_outbox",
  "ack_ticket_sync_outbox",
  "read_ticket_image",
  "put_ticket_image",
  "sync_node_tickets",
  // Shared usage readings move over the link between a command node and its leaf only.
  "collect_shared_usage_readings",
  "apply_shared_usage_readings",
  "create_node_action_request",
  "list_node_action_requests",
  // Each machine's standing permission is for its own coordinators only.
  "run_granted_agent_account_switch",
  "run_timer_agent_account_switch",
  "resolve_node_action_request",
  // Transfers and comparisons are run by the command node, not through it.
  "transfer_node_files",
  "list_node_transfers",
  "compare_project_files",
  "get_project_copy_options",
  "copy_project_to_node",
  "list_project_copies",
  // A coordinator's actions on its nodes run on its own command node.
  "launch_coordinator_node_environment",
  "assert_coordinator_node_delegation_available",
  "assert_coordinator_environment_scope",
  "note_coordinator_node_unavailable",
  "open_coordinator_node_delegation",
  "send_coordinator_node_mail",
  "get_coordinator_node_mailbox",
  // A leaf coordinator's mail to its command node's coordinator is its own.
  "send_coordinator_command_node_mail",
  // Names a coordinator conversation's own attachments, on its own node.
  "transfer_coordinator_attachments",
  "start_coordinator_node_build_pipeline",
  "coordinator_node_ticket",
  "launch_coordinator_node_multi_review",
  "coordinator_node_multi_review_surface",
  "start_coordinator_node_multi_review",
  // Worker surfaces of a coordinator on this node (coordinator.md, "Worker surfaces"), and the
  // apply step only the user's approval of a request runs.
  "launch_coordinator_terminal",
  "open_coordinator_browser",
  "edit_coordinator_worker_tab",
  "create_coordinator_pr",
  "resolve_coordinator_conflicts",
  "launch_coordinator_feature_plan",
  "get_coordinator_feature_plan",
  "custom_fix_coordinator_multi_review_action",
  "request_coordinator_root_changes",
  "apply_project_root_changes",
  "fork_coordinator_worker",
  "get_coordinator_worker_changes",
  // A proposed answer to a worker's question, and the step only the user's
  // approval runs; a worker on another node is answered through
  // `answer_controller_worker_question` instead.
  "request_coordinator_worker_answer",
  "answer_project_worker_question",
  // Sends a coordinator's project-home message only the user approved here.
  "send_approved_project_home_message",
  "stop_coordinator_worker_turn",
  "restart_coordinator_build_pipeline_step",
  "list_coordinator_worker_commands",
  "run_coordinator_worker_command",
  // A coordinator's goals on its own workers: this node holds the ownership.
  "set_coordinator_worker_goal",
  "get_coordinator_worker_goal",
  "pause_coordinator_worker_goal",
  "clear_coordinator_worker_goal",
  // An AGENTS.md proposal and its review belong to the coordinator's command
  // node; the read and the pull request run on the node owning the copy.
  "request_coordinator_agents_md_update",
  "preview_agents_md_update",
  "get_node_summaries",
  "watch_node_events",
  "unwatch_node_events",
  "get_portal_layout",
  "update_portal_layout",
  // The command node's own policy for its leaves (plan item 5006).
  "get_fleet_update_policy",
  "set_fleet_update_policy",
  "open_node_workspace",
  "renew_node_workspace",
  "close_node_workspace",
  // Secrets of the node itself. The two gateway token names are routes, not
  // registered commands; kept so no node ever registers one to be routed.
  "get_gateway_token_settings",
  "set_gateway_token",
  "rotate_control_mcp_token",
  "create_control_mcp_credential",
  "rotate_control_mcp_credential",
  "revoke_control_mcp_credential",
  "get_control_mcp_settings",
]);

/** Whether `command` is never routed to another node (`invoke_on_node`, the portal). */
export function isNodeRoutingExcludedCommand(command: string): boolean {
  return NODE_ROUTING_EXCLUDED_COMMANDS.has(command);
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
    private readonly onChanged?: (nodeId: BackendId) => void,
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
    const existing = this.records.find(
      (record) =>
        record.nodeId === entry.nodeId &&
        record.command === entry.command &&
        record.requestKey === entry.requestKey,
    );
    if (existing) return existing;
    const record: NodeOutcomeRecord = {
      ...entry,
      outcomeId: randomUUID(),
      recordedAt: new Date().toISOString(),
    };
    const evicted = this.records.length >= MAX_NODE_OUTCOMES ? this.records[0] : undefined;
    this.records = [...this.records, record].slice(-MAX_NODE_OUTCOMES);
    await this.persistence?.save(this.records).catch(() => undefined);
    this.onChanged?.(record.nodeId);
    if (evicted && evicted.nodeId !== record.nodeId) this.onChanged?.(evicted.nodeId);
    return record;
  }

  async dismiss(outcomeId: string): Promise<boolean> {
    const dismissed = this.records.find((record) => record.outcomeId === outcomeId);
    if (!dismissed) return false;
    this.records = this.records.filter((record) => record.outcomeId !== outcomeId);
    await this.persistence?.save(this.records).catch(() => undefined);
    this.onChanged?.(dismissed.nodeId);
    return true;
  }
}

export interface RoutableLink {
  readonly connected: boolean;
  invoke<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: { envelope?: ContractEnvelope },
  ): Promise<T>;
}

export type RoutedResult<T> =
  { outcome: "ok"; result: T } | { outcome: "unknown"; requestKey: string; outcomeId: string };

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
  /** Overrides the command-name classification (a routed `public_action` read). */
  read?: boolean;
  /** The contract envelope a domain client picked for this peer (plan item 1010). */
  envelope?: ContractEnvelope;
}): Promise<RoutedResult<T>> {
  if (isNodeRoutingExcludedCommand(input.command)) {
    throw new Error(`${input.command} cannot be run on another node from here.`);
  }
  const read = input.read ?? isNodeReadCommand(input.command);
  if (!input.link || !input.link.connected) {
    throw new NodeUnavailableError(
      read
        ? "That node is not connected; its last-known state is shown."
        : "That node is not connected, so changes to it are disabled.",
    );
  }
  try {
    const result = input.envelope
      ? await input.link.invoke<T>(input.command, input.args, { envelope: input.envelope })
      : await input.link.invoke<T>(input.command, input.args);
    return { outcome: "ok", result };
  } catch (error) {
    if (error instanceof NodeOutcomeUnknownError && !read) {
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
