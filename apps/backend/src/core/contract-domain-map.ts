/**
 * The contract domain of every string-registered backend command (plan item
 * 1006, docs/reports/unified-federation.md §11.2 "Domains" and §11.3).
 *
 * A command registered with its definition (`register(def, handler)`) carries
 * its domain in the definition. Every other command needs an entry here:
 * `scripts/generate-contract-manifest.ts` fails when a registered command is
 * in neither place, so a new string-registered command has to pick a domain.
 * It also fails on an entry for a command that is no longer registered, or
 * that is now registered with its definition (remove the entry when a command
 * adopts `defineCommand`), and on a command listed under two domains.
 *
 * Seeded on 2026-11-07 from Appendix E's grouping by registering file, split
 * into the finer `DOMAIN_NAMES` by command name where one file serves several
 * domains (see the Notes of plans/unified/1006-contract-manifest-generator.md).
 * Each list is sorted.
 *
 * Regenerate the manifest after editing: `mise run contract:manifest`.
 */
import type { DomainName } from "@orkestrator/protocol/contract/domain";

export type ContractDomainMap = { readonly [Domain in DomainName]?: readonly string[] };

export const CONTRACT_DOMAIN_MAP = {
  "agent-mail": [
    "ack_agent_mail",
    "discard_agent_mail_inject",
    "get_agent_mail_conversation",
    "get_agent_mail_inbox_snapshot",
    "get_agent_mail_mailbox",
    "get_agent_mail_mailboxes",
    "get_agent_mail_message",
    "get_agent_mail_status",
    "get_agent_mail_summary",
    "get_agent_messaging_settings",
    "get_agent_registry",
    "list_agent_mail_conversations",
    "list_agent_mail_inbox",
    "list_agent_mail_sent",
    "list_agent_mailboxes",
    "mark_agent_mail_conversation_seen",
    "mark_agent_mail_seen",
    "mute_agent_mail",
    "retry_agent_mail_inject",
    "send_agent_mail",
    "send_external_agent_mail",
    "set_agent_messaging_paused",
    "update_agent_messaging_settings",
  ],
  coordinator: [],
  "multi-review": [
    "address_multi_review",
    "cancel_multi_review",
    "cancel_review_validation",
    "delete_multi_review_workflow",
    "get_multi_review_reviewer_history_page",
    "get_multi_review_reviewer_projection",
    "get_multi_review_reviewer_tool_details",
    "get_multi_review_reviewer_transcript",
    "get_multi_review_step_tool_details",
    "get_multi_review_step_transcript",
    "get_multi_review_workflow",
    "get_review_validation_output",
    "list_multi_review_workflows",
    "pause_multi_review_step",
    "preview_multi_review_code_rewind",
    "recover_multi_review_fix_session",
    "restart_multi_review_reviewer",
    "restart_multi_review_step",
    "resume_multi_review_step",
    "retry_multi_review",
    "rewind_multi_review_code",
    "skip_multi_review_step",
    "start_multi_review",
    "start_multi_review_custom_fix",
    "start_review_validation",
    "status_review_validation",
    "stop_multi_review_reviewer",
    "stop_multi_review_validation",
    "stop_review_validation_command",
    "unstick_multi_review_reviewer",
  ],
  "node-mail": [
    "place_node_mail_attachments",
    "prepare_node_mail_attachments",
    "send_coordinator_command_node_mail",
  ],
  pipelines: [
    "cancel_build_pipeline",
    "clear_task_build_status",
    "create_feature_build",
    "delete_build_pipeline",
    "get_build_pipeline",
    "get_build_pipeline_session_projection",
    "get_build_pipeline_worker_transcript",
    "get_workflow_result_metrics",
    "get_workflow_result_tools_rollout",
    "import_legacy_build_pipelines",
    "launch_build_pipeline",
    "list_build_pipelines",
    "pause_build_pipeline",
    "preview_build_pipeline_code_rewind",
    "remove_queued_build_pipeline_message",
    "restart_build_pipeline_current_step",
    "restart_build_pipeline_reviewer",
    "restart_build_pipeline_step",
    "resume_build_pipeline",
    "retry_build_pipeline_completion_comment",
    "retry_build_pipeline_interaction_failure",
    "retry_build_pipeline_review",
    "retry_build_pipeline_reviewer",
    "retry_build_pipeline_stage",
    "rewind_build_pipeline_code",
    "save_build_pipeline",
    "send_build_pipeline_message",
    "set_environment_unread",
    "set_workflow_result_tools_rollout",
    "skip_build_pipeline_step",
    "start_build_pipeline",
    "start_feature_plan_build",
    "steer_build_pipeline",
    "steer_queued_build_pipeline_message",
    "stop_build_pipeline_reviewer",
  ],
  "public-api": ["public_action"],
  "ticket-sync": ["coordinator_node_ticket"],
} as const satisfies ContractDomainMap;

/**
 * The map as command name to domain. Throws when a command is listed twice
 * (under one domain or two), so an ambiguous entry never picks a domain
 * silently.
 */
export function contractDomainsByCommand(
  map: ContractDomainMap = CONTRACT_DOMAIN_MAP,
): ReadonlyMap<string, DomainName> {
  const byCommand = new Map<string, DomainName>();
  for (const [domain, commands] of Object.entries(map) as [DomainName, readonly string[]][]) {
    for (const command of commands) {
      const known = byCommand.get(command);
      if (known !== undefined) {
        throw new Error(
          known === domain
            ? `Command ${command} is listed twice under contract domain ${domain}.`
            : `Command ${command} is listed under contract domains ${known} and ${domain}.`,
        );
      }
      byCommand.set(command, domain);
    }
  }
  return byCommand;
}
