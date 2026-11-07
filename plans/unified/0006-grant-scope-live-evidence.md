---
id: 0006
title: "Live evidence for the workspace grant command scope (todo 5740)"
phase: 0
plan: "§10.2 and §12 Phase 6.5"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 0006 · Live evidence for the workspace grant command scope (todo 5740)

- **Report:** [§10.2](../../docs/reports/unified-federation.md#102-tighten-the-grant-command-list)
- **Todo:** [5740](../../docs/todo/cross-cutting/5740-workspace-grant-scope-live-evidence.md), tasks 1 and 2
- **Depends on:** none
- **Blocks:** [6001](6001-in-tree-by-default.md) and [7012](7012-allow-listed-grants.md)
- **Parallel with:** everything
- **Size:** S (live qualification)
- **Track:** F (fixes now)

## Goal

Prove between two real backends that a workspace grant (direct and relayed) keeps every workspace feature and is refused administration. That proof is the baseline the allow-list in [7012](7012-allow-listed-grants.md) must reproduce.

## Current state (verified 2026-11-07)

- `NODE_EXCLUDED_COMMANDS` is in `apps/backend/src/core/nodes/node-routing.ts:24-144`, not in `workspace-grant-scope.ts` as the report says.
- `WORKSPACE_ADMINISTRATION_COMMANDS` is in `apps/backend/src/core/nodes/workspace-grant-scope.ts:16-56`. The fail-open warning is at :13-14.
- `isWorkspaceExcludedCommand` (`node-routing.ts:152-199`) combines both lists with an inline list of link and controller plumbing.
- Grant refusal: `gateway-auth.ts:507-508` → 403 in `gateway-handlers.ts:110-126`. Relay refusal: `node-relay.ts:200-221`.
- Unit coverage: `apps/backend/tests/gateway-workspace-grant-scope.test.ts`, `apps/backend/src/core/nodes/workspace-grant-scope.test.ts`.

## Work

- [x] Task 1 of 5740: two `dev:test` profiles, one attached to the other, driven with Playwright.
  - Through the browser realm, once with a direct grant and once with the relay forced:
    - open a leaf environment;
    - run a terminal command;
    - open the agent tab without sending a turn;
    - open the agent and usage popovers, repository settings and the project boards.
  - Confirm that the leaf log has no `This credential cannot run that command.` refusal.
  - POST `update_global_config` and `request_host_update` with the grant and through the relay, and expect 403.
- [x] Task 2 of 5740: a v2.35.1-beta command node (installed into a throwaway data directory; never the real data directory or ports 34121/34122) attached to a current leaf. Favourite a model in the leaf's realm and read `get_compatibility_path_usage` on the leaf.
- [x] Update 5740 with the results, following the todo format rules. Close it if both pass.
- [x] Record the full list of commands a realm actually sent during task 1 (names only), to seed the `access: "workspace"` classification in [7012](7012-allow-listed-grants.md).

## Done when

- [x] Both tasks pass, or the refused commands found are fixed with a regression test.

## Notes

- No billed provider turns unless the user authorises them.
- Results (2026-11-07) are recorded in full in [5740](../../docs/todo/cross-cutting/5740-workspace-grant-scope-live-evidence.md) and summarised in the [measurements report](../../docs/reports/unified-federation-measurements.md#other-live-evidence-from-the-same-run). Task 1: every step passed through the browser realm with a direct grant and with the relay forced (leaf origin blocked in the browser); no realm request was refused (no 403 among 2,146 realm requests; the only errors were `read_local_file` 500s for a missing `orkestrator-ai.json`, the same on the window's own environments); `update_global_config` (a real change) and `request_host_update` returned 403 both with the grant ("This credential cannot run that command.") and through the relay ("That command cannot be relayed to another node."), with read commands 200 on both and the leaf's settings unchanged. Task 2: the published v2.35.1-beta CLI as command node, serving the v2.35.1-beta web build, with a current leaf attached; favouriting Sonnet 5.5 in the leaf's realm succeeded (the realm's `update_global_config` to the leaf over the direct grant answered 200, no error toast, the leaf's `favoriteModels` gained the model) and the leaf's `workspace-grant.config-echo` counter went from absent to 1.
- Deviation: the "leaf log has no refusal" check is not meaningful on its own, because the backend does not log a grant or relay refusal (it only answers 403). The check was made on the browser side instead: every realm request's status was recorded and none was 403. The leaf log was also searched (0 matches).
- Commands a realm sent (task 1, names only), to the leaf over the grant or relay (63): `apply_pane_layout_intent changes_get_view check_claude_cli check_claude_config check_docker check_github_cli create_local_terminal_session create_session delete_compose_draft ensure_project_coordinator ensure_project_home_environment fetch_project_git get_agent_handoff_capabilities get_agent_mail_summary get_agent_model_catalog_cache get_available_ai_cli get_backend_profile get_bug_report get_client_state_capabilities get_compose_draft get_config get_container_host_reachability get_coordinator_checkout_turn get_coordinator_pane_layout get_environment get_environment_process_usage get_environment_snapshot get_environment_snapshots get_environments get_feature_plans get_github_cli_status get_kanban_tasks get_local_file_tree get_native_agent_model_catalog get_opencode_model_catalog_cache get_pane_layout get_pr_monitor_state get_preview_capabilities get_project_coordinator_view get_project_git_status get_projects get_scoped_resource_revision_manifest get_sessions_by_environment get_system_usage get_terminal_state_snapshot get_ticket_sync_status list_build_pipelines list_coordinator_activity list_coordinator_launch_overrides list_environment_hydration list_multi_review_workflows list_prompt_queues load_session_buffer local_terminal_resize local_terminal_write read_local_file save_coordinator_pane_layout save_session_buffer set_environment_unread start_environment start_local_terminal_session sync_all_environments_with_docker update_session_activity`; to the command node over the realm's portal scope: `get_config get_node_status get_node_summaries get_portal_layout`. Task 2's older realm also sent `update_global_config` (answered by the echo path). Not exercised, so not in the list: agent turns, MCP, previews, files panel edits, Git actions, environment creation and settings writes.
- Effect: not used (live qualification only, no code).

## Work log

- 2026-11-07 (claude-worker): ran 5740 tasks 1 and 2 live (two `dev:test` profiles; a v2.35.1-beta npm CLI command node in a throwaway data directory with a current leaf). Both pass; 5740 updated and closed; command list recorded for 7012.
