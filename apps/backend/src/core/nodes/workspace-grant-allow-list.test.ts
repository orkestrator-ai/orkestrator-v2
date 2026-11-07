import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCommandRegistry } from "../commands-registry.js";
import { LEGACY_ONLY_ADMITTED, legacyWorkspaceAdmitted } from "./workspace-grant-legacy-check.js";
import { workspaceAllowList } from "./workspace-grant-scope.js";

/**
 * Plan item 7012: the grant allow-list is the manifest's `access ===
 * "workspace"` set. Before the switch, this test proved that set equal to the
 * deny-lists' effective scope (every registered command minus
 * `isWorkspaceExcludedCommand`) except for the commands below (commit
 * 17577083d); each difference is justified, command by command, in
 * `plans/unified/7012-allow-listed-grants.md` (Notes). The deny-lists are
 * gone; their verdict survives, for one release, as the debug cross-check
 * (`workspace-grant-legacy-check.ts`), which this test keeps in step.
 */

interface ManifestEntry {
  readonly domain: string;
  readonly access?: "workspace" | "admin" | "internal";
  readonly untyped?: true;
}

const manifest = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../../../packages/protocol/contracts/manifest.json"),
    "utf8",
  ),
) as { commands: Record<string, ManifestEntry> };

/**
 * Registered commands the deny-lists left open that the allow-list refuses:
 * none is sent by a client, so nothing a workspace does is lost.
 */
const NARROWED: Readonly<Record<string, "admin" | "internal">> = {
  // Machine-wide diagnostics, counters and operator switches; no client calls them.
  changes_get_diagnostics: "admin",
  get_mcp_management_rollout: "admin",
  set_mcp_management_rollout: "admin",
  get_agent_interaction_observations: "admin",
  reconcile_agent_interactions: "admin",
  set_agent_interaction_monitor_adoption: "admin",
  get_workflow_result_metrics: "admin",
  get_workflow_result_tools_rollout: "admin",
  get_artifact_metrics: "admin",
  get_compatibility_path_usage: "admin",
  get_progressive_read_metrics: "admin",
  get_recurring_work_diagnostics: "admin",
  reconcile_workflow_scheduling: "admin",
  // Called in-process by the backend's own services, never by a client.
  peek_container_agent_bridge: "internal",
  peek_local_agent_bridge: "internal",
  claude_tmux_reconcile_orphans: "internal",
  claude_tmux_submit_queued: "internal",
  reconcile_claude_state_polling: "internal",
  check_container_workspace_paths: "internal",
  delete_container_annotation_evidence: "internal",
  cancel_review_validation: "internal",
  start_review_validation: "internal",
  status_review_validation: "internal",
  pr_monitor_agent_turn_completed: "internal",
  pr_monitor_probe_environment: "internal",
  // Coordinator tool steps (Control MCP, in-process) that trust the scope
  // their caller names; a workspace client never sends them.
  ask_coordinator_suborks: "internal",
  get_coordinator_node_launch_environment: "internal",
  launch_coordinator_environment: "internal",
  open_coordinator_delegation: "internal",
  send_coordinator_agent_mail: "internal",
  start_coordinator_build_pipeline: "internal",
  start_coordinator_graph_run: "internal",
  start_coordinator_multi_review: "internal",
};

describe("the manifest's workspace set and the grant allow-list", () => {
  const commands = Object.entries(manifest.commands);
  const allowList = new Set(
    commands.filter(([, entry]) => entry.access === "workspace").map(([name]) => name),
  );

  test("the runtime allow-list is the manifest's workspace set", () => {
    const runtime = workspaceAllowList(createCommandRegistry().contracts);
    expect([...runtime].sort()).toEqual([...allowList].sort());
  });

  test("the old deny-lists' verdict differs only by the justified commands", () => {
    const legacy = commands
      .map(([name]) => name)
      .filter((name) => legacyWorkspaceAdmitted(name, allowList.has(name), true));
    const narrowed = legacy.filter((name) => !allowList.has(name)).sort();
    expect(narrowed).toEqual(Object.keys(NARROWED).sort());
    expect([...LEGACY_ONLY_ADMITTED].sort()).toEqual(Object.keys(NARROWED).sort());
  });

  test("each narrowed command declares the access its justification names", () => {
    for (const [name, access] of Object.entries(NARROWED)) {
      expect({ name, access: manifest.commands[name]?.access }).toEqual({ name, access });
    }
  });

  test("every command a realm sent in 0006's live pass stays on the allow-list", () => {
    // `plans/unified/0006-grant-scope-live-evidence.md` (Notes), names only.
    const observed = `apply_pane_layout_intent changes_get_view check_claude_cli check_claude_config
      check_docker check_github_cli create_local_terminal_session create_session
      delete_compose_draft ensure_project_coordinator ensure_project_home_environment
      fetch_project_git get_agent_handoff_capabilities get_agent_mail_summary
      get_agent_model_catalog_cache get_available_ai_cli get_backend_profile get_bug_report
      get_client_state_capabilities get_compose_draft get_config get_container_host_reachability
      get_coordinator_checkout_turn get_coordinator_pane_layout get_environment
      get_environment_process_usage get_environment_snapshot get_environment_snapshots
      get_environments get_feature_plans get_github_cli_status get_kanban_tasks
      get_local_file_tree get_native_agent_model_catalog get_opencode_model_catalog_cache
      get_pane_layout get_pr_monitor_state get_preview_capabilities
      get_project_coordinator_view get_project_git_status get_projects
      get_scoped_resource_revision_manifest get_sessions_by_environment get_system_usage
      get_terminal_state_snapshot get_ticket_sync_status list_build_pipelines
      list_coordinator_activity list_coordinator_launch_overrides list_environment_hydration
      list_multi_review_workflows list_prompt_queues load_session_buffer local_terminal_resize
      local_terminal_write read_local_file save_coordinator_pane_layout save_session_buffer
      set_environment_unread start_environment start_local_terminal_session
      sync_all_environments_with_docker update_session_activity`
      .split(/\s+/u)
      .filter(Boolean);
    expect(observed).toHaveLength(63);
    expect(observed.filter((name) => !allowList.has(name))).toEqual([]);
  });

  test("an untyped command is never on the allow-list", () => {
    for (const [name, entry] of commands) {
      if (entry.untyped)
        expect({ name, allowed: allowList.has(name) }).toEqual({ name, allowed: false });
    }
  });
});
