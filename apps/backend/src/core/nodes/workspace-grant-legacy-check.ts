import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("nodes");

/**
 * A debug-only cross-check of the workspace grant allow-list against the
 * deny-lists it replaced (plan item 7012), kept for one release: delete this
 * file, and its call in `admitsWorkspaceCommand`, in the first release after
 * 2.36.
 *
 * The deny-lists (`NODE_EXCLUDED_COMMANDS`, `WORKSPACE_ADMINISTRATION_COMMANDS`
 * and the inline list of `isWorkspaceExcludedCommand`) are gone. When the
 * allow-list replaced them, the two agreed on every registered command except
 * the ones below (`workspace-grant-allow-list.test.ts`, commit 17577083d, and
 * the item's Notes, command by command), and the deny-lists admitted every
 * name they did not list, unknown names included. So the old verdict is the
 * allow-list's, widened by this list and by every name this backend does not
 * register. None of these is sent by a client, so a disagreement logged here
 * names a caller the switch broke.
 */
export const LEGACY_ONLY_ADMITTED: ReadonlySet<string> = new Set([
  // `admin`: machine-wide diagnostics, counters and operator switches.
  "changes_get_diagnostics",
  "get_agent_interaction_observations",
  "get_artifact_metrics",
  "get_compatibility_path_usage",
  "get_mcp_management_rollout",
  "get_progressive_read_metrics",
  "get_recurring_work_diagnostics",
  "get_workflow_result_metrics",
  "get_workflow_result_tools_rollout",
  "reconcile_agent_interactions",
  "reconcile_workflow_scheduling",
  "set_agent_interaction_monitor_adoption",
  "set_mcp_management_rollout",
  // `internal`: called in-process by the backend's own services.
  "cancel_review_validation",
  "check_container_workspace_paths",
  "claude_tmux_reconcile_orphans",
  "claude_tmux_submit_queued",
  "delete_container_annotation_evidence",
  "peek_container_agent_bridge",
  "peek_local_agent_bridge",
  "pr_monitor_agent_turn_completed",
  "pr_monitor_probe_environment",
  "reconcile_claude_state_polling",
  "start_review_validation",
  "status_review_validation",
  // `internal`: coordinator tool steps that trust the scope their caller names.
  "ask_coordinator_suborks",
  "get_coordinator_node_launch_environment",
  "launch_coordinator_environment",
  "open_coordinator_delegation",
  "send_coordinator_agent_mail",
  "start_coordinator_build_pipeline",
  "start_coordinator_graph_run",
  "start_coordinator_multi_review",
]);

/** The old deny-lists' verdict, given the allow-list's and whether the name is registered. */
export function legacyWorkspaceAdmitted(
  command: string,
  admitted: boolean,
  registered: boolean,
): boolean {
  return admitted || !registered || LEGACY_ONLY_ADMITTED.has(command);
}

/**
 * Logs, at `debug` only, a verdict the old deny-lists would have given
 * differently. Content-free: the command's name is logged only when it is one
 * of the fixed names above, never a name a client sent that this backend does
 * not know.
 */
export function crossCheckLegacyWorkspaceScope(
  command: string,
  path: "grant" | "relay",
  admitted: boolean,
  isRegistered: ((command: string) => boolean) | undefined,
): void {
  if (!log.isEnabled("debug")) return;
  const registered = isRegistered?.(command) ?? false;
  const legacy = legacyWorkspaceAdmitted(command, admitted, registered);
  if (legacy === admitted) return;
  log.debug("grant.scope-disagreement", {
    path,
    allowList: admitted ? "admitted" : "refused",
    legacy: legacy ? "admitted" : "refused",
    registered,
    command: LEGACY_ONLY_ADMITTED.has(command) ? command : undefined,
  });
}
