---
id: 5004
title: "Coordinator gate, machine invoke and portal APIs through the command scope"
phase: 5
plan: "§5.1 Command scope and §9"
status: done
depends_on: [4001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 5004 · Coordinator gate, machine invoke and portal APIs through the command scope

- **Report:** [§5.1](../../docs/reports/unified-federation.md#51-scopes), [§9](../../docs/reports/unified-federation.md#9-cross-node-features)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md)
- **Blocks:** [6001](6001-in-tree-by-default.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

What a realm reaches through `window.orkestratorPortal` today becomes a call on the command scope. The `portalInvoke`/`portalListen` split disappears.

## Current state (verified 2026-11-07)

- `lib/portal/portal-transport.ts` (56 LOC; test 106 lines) holds `portalInvoke`, `portalListen` and `portalListenAuthoritative`, using `window.orkestratorPortal` with the global as fallback.
- `LeafModeCoordinatorGate.tsx` (:58-110) uses the portal `self` summary and realm grouping.
- `machineInvoke`: `null` means portal, `undefined` means workspace, and an id means `invokeOnNode`.

## Work

- [x] Make portal APIs command-scope calls: inherited settings, the node registry, grants, portal layout, project copy, outcomes, action requests and handover.
- [x] `LeafModeCoordinatorGate` reads grouping from `machineViewStore` and the command scope.
- [x] `machineInvoke(nodeId)` → `scope(nodeId).client.invoke` for warm and live nodes, or `invoke_on_node` through the command scope for summary-tier nodes. Used for agent accounts and MCP per machine.
- [x] `portal-transport.ts` becomes a thin command-scope adapter, deleted in [6002](6002-delete-web-realm-code.md).

## Tests

- [x] `leaf-mode-coordinator-gate.test.tsx` (434 lines) ported; `machineInvoke` per tier; project copy across nodes.

## Done when

- [x] No in-tree code reads `window.orkestratorPortal`.

## Notes

- **API (2026-11-07).**
  - `apps/web/src/lib/portal/command-scope.ts`: `commandScopeInvoke<T>(command, args?)`, `commandScopeListen<T>(event, handler, options?)`, `commandScopeListenAuthoritative<T>(event, handler, options)`, `commandScopeBackendClient: BackendClient`. The window's command node for every portal API. In an app window (and for every node shown in its tree) they are the command scope's own transport (`@/lib/native/backend` `invoke`, `@/lib/native/events` `listen`: that scope's client and prefetched cache, and what suites mock). In a workspace realm document they are the page's portal channel.
  - `apps/web/src/lib/portal/page-portal.ts`: `workspaceTarget()` (moved here), `pagePortal(): PagePortal | null`. The one module that reads `window.orkestratorPortal`, and only in a page that names a workspace target (`window.orkestratorWorkspaceTarget`). The desktop preload (`exposePortal`) and the browser gateway (`workspaceTargetGatewayOptions`) install the two globals together, in realm documents only, so production behaviour is unchanged. Deleted with realms (6002/6003).
  - `apps/web/src/lib/portal/machine-scope.ts`: `hydratedMachineScope(nodeId, windowScope?)`, `invokeOnMachine<T>(nodeId, command, args?)`, `isWorkspaceGrantCommand(command)`. `lib/backend/client.ts` `machineInvoker` (so `machineInvoke`, `machineBackendClient`, `accountsOn`, `mcpOn`, `systemApiOn`, graphs, previews, docker...) and Settings' `components/settings/machines/machine-access.ts` `machineInvoke` route a node id through it; `null` is `commandScopeInvoke`.
  - `lib/portal/portal-transport.ts` is now only aliases (`portalInvoke = commandScopeInvoke`, `portalListen`, `portalListenAuthoritative`, `workspaceTarget`). Remaining importers use only `workspaceTarget` (`DiagnosticsExportCard`, `account-machine`, `AgentInfoButton`, `FederationProvider`, `useCommandNode`, `leaf-node.ts`, `open-bug-report.ts`; other agents' files this wave, left alone).
  - `lib/backend/client.ts` `portalBackendClient` is now `commandScopeBackendClient` (kept as the name `command-nodes.ts` and the `lib-backend-command-default` guard know).
- **Callers converted.** `portal-store.ts` (registry, status, summaries, outcomes, action requests, root changes), `nodes.ts` `portalNodesApi()` (registry, handover, project copy, layout, outcomes, setup approvals: every `nodes` call of the portal modules and `command-handover.ts`), `project-copy.ts`, `portal-layout.ts`, `fleet-update-policy.ts`, `workspaces.ts` and `node-clients.ts` (grants), `command-node-config.ts` (inherited settings: `pagePortalParent` now asks `pagePortal()` and uses `commandScopeBackendClient`/`commandScopeListen`; `machine === null` targets use `commandScopeBackendClient`), `node-events.ts`, and the component listeners `NodeSshPromptDialog`, `useMachines`, `useMaintenanceSummaries`, `useMachineMaintenance`, `NodeActionRequestsDialog`, `useMcpManagement` (whose `machine === null ? portalListen : listen` is now `commandScopeListen : listen`).
- **Decision: how a realm document is recognised (2026-11-07).** Options: (a) the portal global's presence, as before; (b) `isWorkspaceRealm()` (the URL's realm parameter); (c) the workspace target global (chosen). (a) means every page checks the global, so "no in-tree code reads it" could not be shown by a test (a presence check is a read). (b) is not what the preload keys on, and some realm test fixtures do not set the URL. (c) is exactly what production installs alongside the portal, so behaviour is unchanged, and an app window never touches the portal global. Cost: 3005's tests set only the portal; they now set both globals (`command-node-config.test.ts`, `store-resource-sync.test.ts`, `portal-layout.test.ts`, `accounts.test.ts`, `mcp.test.ts`). 3005's "layering must not read `orkestratorWorkspaceTarget`" still holds: layering reads neither global; `page-portal.ts` does.
- **Decision: machine calls per tier, and only for workspace commands (2026-11-07).** The tier is `NodeScope.tier` (warm or live means the scope; summary, suspended or no scope means `invoke_on_node` through the command scope). 4002 landed concurrently (0c1f68f42) and drives `setTier`; before it, every open scope was `live`, which is "the window has an open scope". **Deviation from a strict reading of report §9, recorded:** a leaf scope holds a workspace grant, which runs only `access: "workspace"` commands and refuses the rest (7012), while `invoke_on_node` runs with the command node's authority. Settings' machine calls include admin commands (`update_backend_profile`, `request_host_update`, `cancel_host_update`, `get_database_stats`, `plan_diagnostics_bundle`), which would 403 on a direct scope. So only a command whose protocol definition says `access: "workspace"` goes to the scope; admin, internal and any command this build has no definition for keep `invoke_on_node`. The lookup covers the domains machine-aware callers reach (accounts, agent-servers, config, docker, environments, graphs, mcp, nodes, previews, projects, system, web-annotations), built once. Agent accounts (33 commands, all workspace) and MCP (11 of 13) therefore go direct for warm and live nodes. A direct write schedules a portal summary refresh, as a routed one does. Calls keep version 0 (no negotiated range), as `machineBackendClient` documented. A realm document keeps today's routing for every node (its one scope is its own leaf labelled command); it is deleted in 6002.
- **Decision: the gate's command node (2026-11-07).** 4005 (d6fbf1eb3) already moved an in-tree leaf's grouping to `useWindowGrouping()` (`machineViewStore` + sort mode + phone layout). This item finishes the command-scope half: `useCommandScopeNode` reads the window's command scope's `projectStore`; a failed read of it now counts as loaded with no summary, so the gate shows "repository information is unavailable" with Try again (which reloads the command scope's projects) instead of waiting for ever; "Open the coordinator on …" names `portalStore.selfId ?? commandScope.nodeId`, so it works before the portal has loaded (`openMachineWorkspace` shows the window's own node for either). A realm document keeps the portal's self summary and the realm message (`usePortalCommandNode`, `realmShellStore`).
- **Done when: what "in-tree" means here.** No renderer file except `lib/portal/page-portal.ts` reads `window.orkestratorPortal` (guard `window-orkestrator-portal`, no baseline, findings 0), and `page-portal.ts` reads it only in a realm document. `command-scope.test.ts` proves at runtime that an app window, and a leaf shown in its tree, make zero reads of the global (a counting getter) while every portal API runs. Realm documents still read it through that one adapter until 6002/6003.
- **Guards.** New `tests/source-guards/window-orkestrator-portal.ts` (registered in `guard.ts`/`scan.ts`; baseline entry `{}`); `direct-transport-import` regenerated with `--guard direct-transport-import --guard window-orkestrator-portal`: the three native-transport imports moved from `portal-transport.ts` to `command-scope.ts` (same count). Another agent was adding `workspace-command-bound-call` to the same three files at the same time; this item's commit holds only its own hunks (temporary index from HEAD).
- **Where Effect is used, and where not.** Not used. The command-scope adapter is two branches over existing promise transports; the tier is a signal read per call; the access lookup is a lazily built `Set`. Lifetimes are the scopes' own (Effect-backed). No retries or timeouts are added.
- **For the report (orchestrator).** §9 "Agent accounts / MCP per machine": add "for commands a workspace grant admits; admin commands keep `invoke_on_node`". §9 "Coordinator across nodes": the in-tree path is `useWindowGrouping` + the command scope's `projectStore`; realms keep the self summary until 6002. §5.1 "Command scope": the realm page's portal channel is read only by `page-portal.ts`.
- **Tests.** Aggregate suite (`mise run test`) left to review preparation.

## Work log

- 2026-11-07 (claude-worker): `command-scope.ts`, `page-portal.ts`, `machine-scope.ts`; `portal-transport.ts` reduced to aliases; every portal module and listener on the command scope; `machineInvoker` and Settings' `machineInvoke` per tier with the workspace-access gate; the gate's command node from the command scope with a retry for a failed read; `window-orkestrator-portal` guard; docs (`federation.md` "The portal channel", `command-nodes.md`, `agent-accounts.md`). Tests: new `command-scope.test.ts` 4 (zero reads of the portal global from an app window and from an in-tree leaf while every portal API runs; project copy across nodes; a realm document's page channel), `machine-scope.test.ts` 10 (summary tier, live, warm, summary and suspended scopes, per-call route, admin and unknown commands, write refresh, Settings' call, realm documents), `leaf-mode-coordinator-gate.test.tsx` +10 in-tree (repository, compact, machine, project, activity, no copy, pending, failed read with retry, portal id, leaf-keyed choice), `portal-transport.test.ts` +1, `tests/unit/window-orkestrator-portal-guard.test.ts` 4; updated realm-simulating tests to install both page globals and command-window tests to route through the command scope (`DockerSettings`, `AgentSignInCard`, `maintenance-hooks`, `SettingsPage.machine-routing`, `CoordinatorAccountSwitchGrant`). Focused runs: web `src/lib` (all), `src/components src/stores src/contexts src/hooks src/App.test.tsx` (all pass), root `./tests/unit/{components,hooks,stores,contexts}` pass; `tests/unit/source-guards.test.ts` fails only on other guards' pre-existing/other agents' test-file findings, none for this item's files. Web typecheck clean; fmt and oxlint clean on touched files (no `import/no-cycle`).

