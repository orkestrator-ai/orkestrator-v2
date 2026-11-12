---
id: 7012
title: "Derive the grant allow-list from the manifest and fail closed"
phase: 7
plan: "§10.2 and §12 Phase 7"
status: done
depends_on: [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009, 0006]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7012 · Derive the grant allow-list from the manifest and fail closed

- **Report:** [§10.2 Tighten the grant command list](../../docs/reports/unified-federation.md#102-tighten-the-grant-command-list)
- **Depends on:** every Phase 7 domain item ([7001](7001-domain-native-sessions.md) to [7009](7009-domain-coordinator-servers-system.md)) and [0006](0006-grant-scope-live-evidence.md)
- **Size:** M
- **Track:** C (contract), security

## Goal

A workspace grant can run exactly the commands whose definition says `access: "workspace"`. A new command is refused through a grant until it declares otherwise.

## Current state (verified 2026-11-07)

- The deny-lists:
  - `NODE_EXCLUDED_COMMANDS` (`apps/backend/src/core/nodes/node-routing.ts:24-144`);
  - `WORKSPACE_ADMINISTRATION_COMMANDS` (`workspace-grant-scope.ts:16-56`, which warns that it fails open);
  - the inline list in `isWorkspaceExcludedCommand` (`node-routing.ts:152-199`).
- Enforcement points: grants (`gateway-auth.ts:507-508` → `gateway-handlers.ts:110-126`) and the relay (`node-relay.ts:200-221`).
- `invoke_on_node` routing is a different path and is unaffected by the grant lists.

## Work

- [x] Prove equivalence before switching. A test computes the allow-list from the manifest (`access === "workspace"`) and compares it with today's effective set (every registered command minus `isWorkspaceExcludedCommand`). Any difference must be justified in Notes, command by command.
- [x] Switch grant and relay refusal to "not in the allow-list", failing closed. Keep the old function as a debug-only cross-check for one release, logging content-free disagreements.
- [x] Delete `NODE_EXCLUDED_COMMANDS`, `WORKSPACE_ADMINISTRATION_COMMANDS` and the inline list once nothing reads them. Keep the separate `invoke_on_node` exclusions if they still serve routing, renamed for that purpose.
- [x] Re-run [0006](0006-grant-scope-live-evidence.md)'s live checks against the new list.
- [x] Update `docs/architecture/command-nodes.md` and `renderer-security.md`.

## Tests

- [x] An unregistered or undefined command is refused through a grant and the relay. Every `workspace` command is admitted. Every `admin` and `internal` command is refused.
- [x] Existing grant-scope tests pass.

## Done when

- [x] Grants fail closed in production, and the deny-lists are gone.

## Notes

- **Started 2026-11-07 on the basis that every command is defined with its `access`.** 7001, 7007 and 7008 still had open boxes, but only about test-fake edits and moving shared model types. The last five untyped commands (`send_coordinator_command_node_mail`, `prepare_node_mail_attachments`, `place_node_mail_attachments`, `coordinator_node_ticket`, `public_action`) were defined in `09d81f2b3` before the equivalence test was finalised. They are `internal`, `internal`, `internal`, `internal` and `admin`, which matches the old refusal of all five. The manifest has 999 commands, all defined, with no untyped ones.
- **Equivalence (2026-11-07, `17577083d`).** `apps/backend/src/core/nodes/workspace-grant-allow-list.test.ts` compared the manifest's `workspace` set with the deny-lists' effective set (every manifest command minus `isWorkspaceExcludedCommand`). Before any change there were 27 differences. I reclassified three groups:
  - **`get_ticket_sync_status`: `admin` → `workspace`.** The deny-lists were right and the conversion was wrong. 1010 made it `admin` on the belief that "every pilot command is workspace-excluded", but this one never was. The Kanban board's sync strip (`TicketSyncStrip`, `lib/backend/kanban.ts`) reads it, and 0006 saw a realm send it to the leaf over the grant.
  - **`graph_capability_ceiling_set`: `workspace` → `admin`.** The deny-lists were right and the conversion was wrong. It was in `WORKSPACE_ADMINISTRATION_COMMANDS` (the machine's graph capability ceiling), so a grant was already refused it. 7007's note "none is in the workspace deny-lists" missed it.
  - **Eight coordinator tool steps: `workspace` → `internal`.** The commands are `launch_coordinator_environment`, `open_coordinator_delegation`, `start_coordinator_build_pipeline`, `start_coordinator_graph_run`, `start_coordinator_multi_review`, `send_coordinator_agent_mail`, `ask_coordinator_suborks` and `get_coordinator_node_launch_environment`. This narrows the old scope, and 7009 flagged it for this item. These commands trust the coordinator `scope` their caller names. Only the Control MCP tools call them, in process (`control-mcp/*-tools.ts`, `coordinator-*-actions.ts`). Nothing in web, desktop or the CLI calls them, by name or through a domain client.
- **The final differences: 33 commands that the deny-lists admitted and the allow-list refuses. None works the other way.** No client sends any of them: I checked web, desktop and CLI sources by name, by definition constant and through every domain `client.ts`. Command by command:
  - `admin`: machine-wide diagnostics, counters and operator switches that no client calls.
    - `changes_get_diagnostics` (7006).
    - `get_mcp_management_rollout` and `set_mcp_management_rollout` (7008, the operator kill switch).
    - `get_agent_interaction_observations`, `reconcile_agent_interactions` and `set_agent_interaction_monitor_adoption` (7001).
    - `get_workflow_result_metrics` and `get_workflow_result_tools_rollout` (7007; their sibling `set_workflow_result_tools_rollout` was already refused).
    - `get_artifact_metrics`, `get_compatibility_path_usage`, `get_progressive_read_metrics`, `get_recurring_work_diagnostics` and `reconcile_workflow_scheduling` (7009). Settings and the CLI still reach these on another machine with `invoke_on_node` or the full token.
  - `internal`: commands the backend calls in process only.
    - `peek_container_agent_bridge` and `peek_local_agent_bridge` (the native-agent service).
    - `claude_tmux_reconcile_orphans`, `claude_tmux_submit_queued` and `reconcile_claude_state_polling` (teardown, the queue drainer and startup).
    - `check_container_workspace_paths` and `delete_container_annotation_evidence` (web annotations).
    - `start_review_validation`, `status_review_validation` and `cancel_review_validation` (the supervisors).
    - `pr_monitor_agent_turn_completed` and `pr_monitor_probe_environment` (the backend's completion and idle edges).
  - `internal`: the eight coordinator tool steps above.
- **Not narrowed (other items' candidates), deliberately.**
  - 7004's `get_preview_settings`, `get_preview_diagnostics` and `revoke_preview_access`: the environment's preview services panel calls them through the previews domain client (`settings`, `diagnostics`, `revokeAccess`), so a realm uses them.
  - `record_preview_client_metrics`: desktop's `preview-transport-manager.ts` sends it.
  - The web annotation rollout, metrics and migrate commands: the web's settings diagnostics and annotation store call them.
  - `transcript_artifact_prepare_worker`: it is in the artifact client.
  - 7006's review package probes: environment-scoped, so narrowing them gains nothing.
  - 7008's `connect_linear`/`disconnect_linear`: `config-integrations.ts` calls them.
  - 7001's host actions: a leaf window calls them.
  - Narrowing any of these needs a check of whether a realm sends it. Leave that for a follow-up with a live pass.
- **Where the allow-list comes from (decision).**
  - Option 1: read the committed `manifest.json` at runtime. Pro: it is literally "the manifest". Con: it is a generated file the binary would have to ship and find, and it can be stale in development.
  - Option 2: an aggregate of every protocol definition. Con: none exists, and it would include commands this build does not register.
  - **Option 3 (taken): the backend registry's own definitions (`CommandRegistry.contracts`).** This is the same map the manifest is generated from, so `mise run contract:check` keeps the two equal. A test asserts `workspaceAllowList(createCommandRegistry().contracts)` equals the manifest's `workspace` set.
  - How it is wired: `BackendCore.commandAccess(command)` exposes the map as `BackendInvoker.commandAccess?`. The gateway's `GatewayAuth.admitsWorkspaceCommand` calls `admitsWorkspaceCommand(command, path, { accessOf, isRegistered })` in `nodes/workspace-grant-scope.ts`.
  - It fails closed in every case: no definition (a string-registered command), an unknown name, and a backend without `commandAccess` (a fake or embedder) all get 403.
- **The relay applies the command node's list (deviation from a strict reading).** The relay runs on the command node, so it checks the command node's registry. Against a newer leaf, a command only that leaf defines is refused through the relay. A direct grant still works for it, because the leaf checks direct grants itself. The command node only gets that command once it upgrades. Failing closed was the item's goal; the leaf's own access is not on the wire, and fetching it per call would put a round trip on every relayed invoke. Recorded in `command-nodes.md#security`.
- **Debug-only cross-check (decision).** The item asks for two things that conflict: keep the old function for one release, and have the deny-lists gone.
  - Option 1: keep the three lists in a legacy file for one release. Con: the lists would not be gone.
  - Option 2: drop the cross-check. Con: it is required.
  - **Option 3 (taken): keep the old verdict, not the old lists.** `nodes/workspace-grant-legacy-check.ts` holds `LEGACY_ONLY_ADMITTED`, the 33 commands above. The old verdict equals "allow-list, or one of those, or any unregistered name", which the equivalence test proved at `17577083d`. With `nodes` at `debug`, `crossCheckLegacyWorkspaceScope` logs `nodes grant.scope-disagreement` with `{ path, allowList, legacy, registered, command? }`. It names the command only when it is one of those fixed names, so the log is content-free.
  - Limitation: a command added after 7012 is compared as if the old lists had known it.
  - Delete the file and its call in the first release after 2.36.
- **`invoke_on_node` exclusions kept and renamed.** `NODE_EXCLUDED_COMMANDS` and `isNodeExcludedCommand` are now `NODE_ROUTING_EXCLUDED_COMMANDS` and `isNodeRoutingExcludedCommand` (`node-routing.ts`); `routeToNode` still reads them. They cannot be derived from `access`: routing uses the link's full credential and routes most `admin` commands (Settings on another machine), but none of the node's own registry and grant commands. The two unregistered names in the list (`get_gateway_token_settings`, `set_gateway_token`, which are gateway routes) are kept so that no node ever routes one. `WORKSPACE_ADMINISTRATION_COMMANDS`, the inline list and `isWorkspaceExcludedCommand` are deleted. Former readers in tests now use `grantAdmits` (`nodes/workspace-grant-test-support.ts`, over the real registry). The gateway test harness's default fake backend reports the real registry's `access`.
- **Live re-run of 0006 (2026-11-07).**
  - Setup:
    - Profiles `uf-7012-cmd` and `uf-7012-leaf` from a detached worktree `output/agent-testing/live-wt4` at `bcee847cf`, which includes this item's commits, with a frozen install.
    - Both started with `--fixture --no-agent-credentials --headless --agent-platforms claude` and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, every inherited `ORKESTRATOR_*` variable unset.
    - Leaf attached with `add_node` (loopback route); a `leaf-env` local environment.
    - Headless Chromium driven over CDP with 0006's scripts, copied to `output/agent-testing/7012/live/`.
  - **Exercise:** opened the leaf environment, ran `echo` in its terminal, opened an agent tab without a turn, the agent and usage popovers, Repository Settings and the project boards. I ran it once on the direct grant (realm `path: "direct"`) and once with the relay forced (every browser request to the leaf's origin aborted; realm `path: "relay"`). Every step rendered on both.
  - **Request results:** 612 `/__orkestrator/` requests (277 direct, 335 relay), none 403. The only errors were five `read_local_file` 500s for the fixture's missing `orkestrator-ai.json`, the same as in 0006.
  - **What the realm sent:** 60 distinct commands to the leaf (`realm-commands.txt`), all `workspace`. It sent `get_config`, `get_node_status`, `get_node_summaries` and `get_portal_layout` to the command node's own portal scope, not through a grant. Compared with 0006's 63, `get_agent_handoff_capabilities` and `get_client_state_capabilities` are no longer sent: capability reads retired by Phase 7.
  - **Refusal checks** (`grant-refusals.json`). Direct grant and relay gave the same results:
    - 200: `get_config`, `get_projects`, `get_ticket_sync_status`.
    - 403: `update_global_config` (a real change, and the leaf's settings were unchanged), `request_host_update`, `get_compatibility_path_usage`, `launch_coordinator_environment`, `deliver_node_mail` and the unknown name `no_such_command_7012`. The messages were "This credential cannot run that command." on the grant and "That command cannot be relayed to another node." on the relay.
  - Profiles stopped and reset, and the worktree removed afterwards.
  - Deviation: the committed HEAD's protocol build failed on three protocol test files with type errors from concurrent items (`native-sessions.test.ts`, `projects-config.test.ts`, `terminals-files-tmux.test.ts`). Those tests do not change runtime. I prefixed them with `// @ts-nocheck` in the throwaway worktree only, so the bridge build could run.
- **Effect:** not used. The allow-list is a synchronous predicate on the gateway's hot path over the registry's existing map, and wrapping it in an Effect would only add allocation per request.
- **Tests run (focused):**
  - Backend: 21 files, 377 tests. Everything passes except one, `domain-adapter-usage.test.ts` "counts the listed legacy adapters". That test depends on `adapters.json` now listing a git version-0 adapter, from another item; none of the lines it checks were changed here.
  - Protocol: `src/contract/domains` and `src/log-vocabulary` pass.
  - Backend typecheck passes. The protocol typecheck fails only in the three concurrent test files above.
  - `tests/unit/source-guards.test.ts` shows only the known baseline drift in files outside this item.
  - Aggregate suite left to review preparation.
- **For the orchestrator:**
  - Report §10.2 still describes the deny-lists as current. It could say they were replaced in 7012 by the registry's `access: "workspace"` allow-list, failing closed, with `invoke_on_node`'s routing exclusions kept as `NODE_ROUTING_EXCLUDED_COMMANDS`.
  - `docs/todo/coordinator-and-multi-review/0395-…` still names `NODE_EXCLUDED_COMMANDS`.

## Work log

- 2026-11-07 (claude-worker):
  - Built the equivalence test and fixed `access` for `get_ticket_sync_status`, `graph_capability_ceiling_set` and the eight coordinator tool steps; regenerated the manifest under the contract lock (`17577083d`).
  - Switched grants and the relay to the allow-list, failing closed, with the debug cross-check; deleted the deny-lists and renamed the routing exclusions (`ce1d49a5b`).
  - Updated the docs (`7e881484b`).
  - Re-ran 0006's live checks on two `dev:test` profiles, direct and relayed: no 403 for any realm request, and administration, narrowed and unknown commands refused.
- 2026-11-10: the debug cross-check (`nodes/workspace-grant-legacy-check.ts`) and its equivalence assertion are removed, as planned for the first release after 2.36 (v2.37.0-alpha to v2.37.4-beta shipped it). `NARROWED` in `workspace-grant-allow-list.test.ts` still records each narrowed command's justified access.
