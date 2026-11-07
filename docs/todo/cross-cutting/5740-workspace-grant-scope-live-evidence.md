# Workspace grant scope: live evidence on two machines

## Task analysis

Analysed 2026-11-07 against `unified-federation-b4c9ee65814d` at `9ee281002` (first analysed 2026-11-05 against `main` at `e1f4c875`).

Closed 2026-11-07: both tasks passed live (plan item [0006](../../../plans/unified/0006-grant-scope-live-evidence.md)). Nothing is left to do. The file stays because plans and the design report link to it.

### Tasks

1. **Two-node realm check**: a realm opened through a real client grant, and one through the relay, runs terminals and agent chat but is refused global settings and host updates. Status: done (2026-11-07).
2. **Older realm favourite check**: a realm served by a command node on v2.35.1-beta or earlier can still favourite a model on an upgraded leaf. Status: done (2026-11-07).

### 1. Two-node realm check

**Problem.** Security report 0200 (I1) was built and tested against a real gateway, but with a fake backend and a fake leaf. It had never run between two real backends. So two things were unproven:

- that a workspace a user opens on another machine keeps every feature it had;
- that a grant is refused administration end to end.

**Context.** Since 2026-11-05, two paths refuse `WORKSPACE_ADMINISTRATION_COMMANDS` (`apps/backend/src/core/nodes/workspace-grant-scope.ts`):

- a client grant (`apps/backend/src/gateway-auth.ts`, `refuseCommand: isWorkspaceExcludedCommand`);
- the relay (`relayHttp`, `apps/backend/src/core/nodes/node-relay.ts`).

The refused commands cover global settings writes, machine credentials, the machine's profile, storage, preview and log settings, the graph capability ceiling, and host updates.

These stay open: terminals, agent chat, previews, files, repository settings, agent sign-in and the project boards.

Settings reach another machine through `invoke_on_node`, which these lists do not affect. Unit coverage: `apps/backend/tests/gateway-workspace-grant-scope.test.ts` and `apps/backend/src/core/nodes/workspace-grant-scope.test.ts`.

**Investigation.** Run live on 2026-11-07 on one Mac (`arktech-mini`).

Setup:

- Two `dev:test` profiles from a worktree at `9ee281002`: `uf-live-cmd` and `uf-live-leaf`. Both used `--fixture --no-agent-credentials --headless --agent-platforms claude` and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`.
- The leaf was attached with `add_node` (loopback route, the leaf's gateway token read into memory only).
- A headless Chromium was driven with Playwright on `uf-live-cmd`'s `browserUrl`.

Each step was run twice through the browser realm:

- once with a direct grant (the realm reported `path: "direct"`);
- once with the relay forced (the browser refused every request to the leaf's origin, and the realm reported `path: "relay"`; its info panel read "Relayed through arktech-mini, which reaches Leaf over HTTPS").

The steps:

1. Open a leaf environment (it started on selection).
2. Run `echo` in its terminal.
3. Open a native agent tab, without sending a turn.
4. Open the agent information and environment process usage popovers, which opened inside the realm.
5. Open Repository Settings (the leaf's own repository).
6. Open the project boards: Home, Coordinator, Kanban, Features.

Every step rendered, on both paths.

Request results:

- Every `/__orkestrator/` request was recorded with its frame, route and status: 2,146 realm requests in total (1,592 direct, 324 relayed, 230 portal).
- **None was answered 403.**
- The only errors were twenty 500s from `read_local_file` for `orkestrator-ai.json`, which the fixture does not have. The window's own environments get the same 500.
- The backend does not log a grant or relay refusal; it only answers 403. Searching the leaf's log (0 matches) therefore proves nothing on its own, so the browser-side statuses are the evidence.

Administration was then posted directly, with a workspace grant from `open_node_workspace` and through `/__orkestrator/nodes/<leaf>/` with the command node's credential:

| Route | `get_config` | `get_projects` | `update_global_config` (a real change) | `request_host_update` |
|---|---|---|---|---|
| Direct grant | 200 | 200 | 403 "This credential cannot run that command." | 403, same |
| Relay | 200 | 200 | 403 "That command cannot be relayed to another node." | 403, same |

The leaf's settings were unchanged afterwards.

Commands the realm sent to the leaf over the grant or the relay (63, names only):

`apply_pane_layout_intent changes_get_view check_claude_cli check_claude_config check_docker check_github_cli create_local_terminal_session create_session delete_compose_draft ensure_project_coordinator ensure_project_home_environment fetch_project_git get_agent_handoff_capabilities get_agent_mail_summary get_agent_model_catalog_cache get_available_ai_cli get_backend_profile get_bug_report get_client_state_capabilities get_compose_draft get_config get_container_host_reachability get_coordinator_checkout_turn get_coordinator_pane_layout get_environment get_environment_process_usage get_environment_snapshot get_environment_snapshots get_environments get_feature_plans get_github_cli_status get_kanban_tasks get_local_file_tree get_native_agent_model_catalog get_opencode_model_catalog_cache get_pane_layout get_pr_monitor_state get_preview_capabilities get_project_coordinator_view get_project_git_status get_projects get_scoped_resource_revision_manifest get_sessions_by_environment get_system_usage get_terminal_state_snapshot get_ticket_sync_status list_build_pipelines list_coordinator_activity list_coordinator_launch_overrides list_environment_hydration list_multi_review_workflows list_prompt_queues load_session_buffer local_terminal_resize local_terminal_write read_local_file save_coordinator_pane_layout save_session_buffer set_environment_unread start_environment start_local_terminal_session sync_all_environments_with_docker update_session_activity`

To the command node over its portal scope, the realm sent: `get_config get_node_status get_node_summaries get_portal_layout`.

Not exercised: agent turns, MCP, previews, file edits, Git actions, environment creation and repository settings saves.

Evidence is in the ignored `output/agent-testing/uf-live/`: `requests-*.jsonl`, `grant-refusals.json` and the `direct-*` and `relay-*` screenshots.

**Decisions.**

- **How to qualify?**
  - **Two `dev:test` profiles, one attached to the other, driven with Playwright through the browser realm and with the relay forced (recommended).** Taken; see Investigation.
    - Pros: exercises the real realm code path and both transports, and finds any refused command a realm actually sends.
    - Cons: needs two profiles and the attach flow. A provider turn must stay out of it unless one is authorised.
  - **Count refusals in production logs instead.**
    - Pros: no setup.
    - Cons: needs real multi-machine use first, and a user finds the refused feature rather than a check. Refusals are not logged either (see Investigation).

### 2. Older realm favourite check

**Problem.** Realms of command nodes on v2.35.1-beta and earlier save a model favourite by sending the leaf its own settings back, with `update_global_config` and `preserveInheritedSettings`. An upgraded leaf now answers that unchanged echo with its current settings instead of refusing it (`isGlobalConfigEcho`, counted as `workspace-grant.config-echo`). The request shape had been read from the v2.35.1-beta sources and replayed in the gateway test, not taken from a running older realm.

**Context.** The compatibility path and its retirement condition are in the register of [version-compatibility.md](../../architecture/version-compatibility.md#register).

If the older realm's copy of the leaf's settings is stale, the echo is not a no-op and the leaf refuses it, so the favourite save fails with "Could not save model favorites". That is deliberate: otherwise the older realm would write stale machine settings back to the leaf.

**Investigation.** Run live on 2026-11-07 on one Mac.

The command node:

- the published npm CLI `orkestrator@2.35.1-beta` (`npm pack`, run as `bin/orkestrator.js serve`) with `--command-node`;
- a throwaway data directory and HOME under `/tmp`;
- random loopback ports, `ORKESTRATOR_CONTROL_MCP_PORT=0`, and the host session's `ORKESTRATOR_*` variables removed, so it reported 2.35.1-beta;
- the v2.35.1-beta web client, built from the `v2.35.1-beta` tag and served with `--renderer-root`, because the npm package carries no web client.

The leaf:

- a current backend (2.36.6-beta, branch source) in a throwaway data directory;
- given the isolated `uf-live-leaf` profile's last-known model catalogue, so the model picker had models;
- attached with `add_node`.

In a headless Chromium signed in to the older command node:

1. The leaf's environment opened as a realm on the direct grant.
2. In a new agent tab's model picker, "Add Sonnet 5.5 to favorites" was clicked.

Results:

- The realm sent `update_global_config` to the leaf over the grant, which answered **200**.
- No error toast appeared, and the picker then offered "Remove Sonnet 5.5 from favorites".
- The leaf's `favoriteModels` gained `{ platform: "claude", modelId: "sonnet" }`.
- `get_compatibility_path_usage` on the leaf went from no paths to `workspace-grant.config-echo` count 1.

Evidence: `output/agent-testing/uf-live/5740-task2-favourite.json` and `old-favourite-after.png`.

**Decisions.**

- **How to check?**
  - **Run a v2.35.1-beta command node attached to a current leaf, favourite a model in the leaf's realm, and read `get_compatibility_path_usage` on the leaf (recommended).** Taken, with the published CLI and a web build from the tag; see Investigation.
    - Pros: proves the exact older client, and the counter shows that the path ran.
    - Cons: an older release on an isolated profile takes setup. It must not touch the real data directory or ports 34121 and 34122.
  - **Rely on the replayed request in the gateway test.**
    - Pros: already done.
    - Cons: a renderer default the sources do not show (an extra key in the store's copy) would make the live echo differ and be refused.

## Assumptions and decisions

### Task 1: the refusal check is made in the browser, not the leaf log

The plan said to confirm that the leaf log has no `This credential cannot run that command.` refusal. The backend answers a refused grant or relay command with a 403 and logs nothing. An empty log would prove nothing, so every realm request's status was recorded in the browser instead (no 403). The leaf log was still searched (0 matches).

### Task 1: the relay was forced in the browser

The relay was forced by refusing every browser request to the leaf's origin. On a first run that interception was done in the test client and blocked its own event loop, which stalled all requests; that run was discarded and redone with the client staying responsive.

Later connection measurements used Chromium's own `Network.setBlockedURLs`. Either way the realm falls back to the relay exactly as when the leaf is unreachable from the client.

### Task 2: the older command node is the npm CLI plus a web build from the tag

The v2.35.1-beta npm package has no web client, and the hosted client is current, not 2.35.1. The older realm code was therefore built from the `v2.35.1-beta` tag and served by the older backend.

No desktop app was installed, and no service was installed.

### Task 2: the leaf gets a model catalogue

A credential-free leaf in a fresh HOME lists no models, so nothing could be favourited. The leaf was started with the catalogue cache files that `dev:test` had seeded into the isolated `uf-live-leaf` profile. These hold model metadata only: no credentials, and nothing from the production data directory.

### Closing the todo

Both tasks passed, so the todo is closed. It is kept in place, marked closed, because `plans/unified/` and `docs/reports/unified-federation.md` link to it. Delete it, with its index row, when those links are updated.

## Related

- Security review: outstanding work (`git show 413bd6219:docs/reports/security/0000-index.md`) (I1)
- [command-nodes.md](../../architecture/command-nodes.md)
- [version-compatibility.md](../../architecture/version-compatibility.md#register)
- [Wave 0 measurements](../../reports/unified-federation-measurements.md)
- Plan items [0006](../../../plans/unified/0006-grant-scope-live-evidence.md) and [7012](../../../plans/unified/7012-allow-listed-grants.md) (the command list above seeds its `access: "workspace"` classification)
