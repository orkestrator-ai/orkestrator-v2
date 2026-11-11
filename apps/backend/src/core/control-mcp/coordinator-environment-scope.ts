import type { JsonRecord } from "./tool-support.js";

/**
 * How each coordinator tool that names an environment or workflow stands with the origin
 * check (`coordinator-environment-scope.ts`). A test fails on a tool taking an
 * environment that is in none of these lists, so a new one has to choose.
 */

type EnvironmentTarget = {
  environmentId?: unknown;
  pipelineId?: unknown;
  workflowId?: unknown;
  nodeId?: unknown;
};

const named = (input: JsonRecord): EnvironmentTarget => input;

/** Tools that send an environment work or change it: checked before they run. */
export const COORDINATOR_ENVIRONMENT_ACTIONS: ReadonlyMap<
  string,
  (input: JsonRecord) => EnvironmentTarget
> = new Map([
  ["cancel_multi_review", (input) => ({ workflowId: input.workflowId, nodeId: input.nodeId })],
  ["pause_build_pipeline", (input) => ({ pipelineId: input.pipelineId, nodeId: input.nodeId })],
  ["cancel_build_pipeline", (input) => ({ pipelineId: input.pipelineId, nodeId: input.nodeId })],
  ["resume_build_pipeline", (input) => ({ pipelineId: input.pipelineId, nodeId: input.nodeId })],
  [
    "restart_build_pipeline_step",
    (input) => ({ pipelineId: input.pipelineId, nodeId: input.nodeId }),
  ],
  ["launch_job", named],
  ["send_prompt_to_tab", named],
  ["launch_terminal", named],
  ["open_worker_browser", named],
  ["edit_worker_tab", named],
  ["stop_worker_turn", named],
  ["run_worker_command", named],
  ["set_worker_goal", named],
  ["pause_worker_goal", named],
  ["clear_worker_goal", named],
  ["fork_worker", named],
  ["start_environment", named],
  ["stop_environment", named],
  ["create_pr", named],
  ["resolve_conflicts", named],
  ["launch_multi_review", named],
  [
    "start_build_pipeline",
    (input) => ({ environmentId: input.existingEnvironmentId, nodeId: input.nodeId }),
  ],
  [
    "launch_graph",
    (input) => ({
      environmentId:
        input.environment && typeof input.environment === "object"
          ? (input.environment as JsonRecord).environmentId
          : undefined,
    }),
  ],
  [
    "transfer_files",
    (input) => (input.to && typeof input.to === "object" ? (input.to as JsonRecord) : {}),
  ],
]);

/**
 * `send_message` is checked by its commands (`send_coordinator_agent_mail`,
 * `send_coordinator_node_mail`), because a reply's real destination is resolved
 * inside the tool, and the addresses that are coordinators are not environments.
 */
export const COORDINATOR_ENVIRONMENT_CHECKED_BY_COMMAND: ReadonlySet<string> = new Set([
  "send_message",
  "address_multi_review",
  "custom_fix_multi_review",
  "cancel_graph_run",
]);

/** Reads: they send nothing to the environment and start nothing in it. */
export const COORDINATOR_ENVIRONMENT_READS: ReadonlySet<string> = new Set([
  "get_launch_options",
  "get_environment",
  "list_tabs",
  "list_agents",
  "get_tab_state",
  "get_tab_transcript",
  "list_mailboxes",
  "read_messages",
  "get_message",
  "get_message_status",
  "ack_message",
  "get_worker_changes",
  "list_worker_commands",
  "get_worker_goal",
  "read_node_environment",
  "list_environments",
  "list_graph_templates",
  "get_build_pipeline",
  "get_multi_review",
  "open_multi_review",
  "open_multi_review_fix",
  "get_graph_run",
]);

/**
 * Requests: the tool only asks, and nothing happens unless the user approves
 * that request, so the user is already the one deciding.
 */
export const COORDINATOR_ENVIRONMENT_USER_APPROVED: ReadonlySet<string> = new Set([
  "answer_worker_question",
  "request_root_changes",
  "request_environment_deletion",
  "request_project_file_update",
  "request_env_value_reveal",
]);
