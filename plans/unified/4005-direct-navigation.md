---
id: 4005
title: "Replace navigation realm messages with direct calls"
phase: 4
plan: "§12 Phase 4.3 and Appendix C"
status: done
depends_on: [4001, 3006]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 4005 · Replace navigation realm messages with direct calls

- **Report:** [Appendix C](../../docs/reports/unified-federation.md#appendix-c-the-realm-protocol-and-what-replaces-it)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md), [3006](3006-ui-store-split.md)
- **Parallel with:** [4002](4002-hydration-tiers-and-budgets.md), [4003](4003-snapshot-first-rehydration.md), [4004](4004-runtime-shim-guard.md), Phase 5
- **Size:** M
- **Track:** S (scopes)

## Goal

For in-tree nodes, navigation and shared chrome use the window stores directly. The loopback from [4001](4001-in-tree-workspace-seam.md) carries none of these messages.

## Messages handled here

The remaining messages (`panel`, `settings`, `bugReport`, `shortcut`, `panelDismissed`, `titleBar`) are in [5002](5002-pr-opener-and-title-bar.md) and [5003](5003-settings-bug-report-shortcuts-dialogs.md).

| Direction | Message | Replacement |
|---|---|---|
| shell → realm | `select` {projectId, environmentId, boardTab, workTarget, addProject, createEnvironmentProjectId, dialog, bugReport} | node-qualified selection, plus `scope.dialogs.open` |
| shell → realm | `sidebar` {open} | read the window store |
| shell → realm | `filesPanel` {open} | read `filesPanelChromeStore` ([3007](3007-files-panel-split.md)) |
| shell → realm | `grouping` | read `machineViewStore` |
| shell → realm | `visibility` ([0003](0003-hidden-realm-visibility.md)) | the scope's tier |
| realm → shell | `ready` | removed; hydration checks replace readiness gating |
| realm → shell | `selection` | one selection |
| realm → shell | `open` | direct `openMachineWorkspace` |
| realm → shell | `sidebar`, `filesPanel` | direct store writes |

## Work

- [x] Replace each message for in-tree nodes, one per commit. *(The first part is met: one commit per message, Work log.)*
- [x] Superseded 2026-11-07: 6002/6003 (`4312188ab`, `0c3e0a37b`) deleted the realm nodes, so there is no realm behaviour to keep. Keep realm behaviour for realm nodes.
- [x] `WorkspaceRealmHost` dialog gating becomes hydration checks on the scope (a project dialog waits for the project list to be live, not for `ready`).
- [x] Coordinator work targets and the bug report flag from [0001](0001-realm-request-drift.md) work in-tree.

## Tests

- [x] For an in-tree node: sidebar click, ⌘K, a work-target open, every dialog in `RealmDialog`, and cross-node open from inside a workspace.

## Done when

- [x] An in-tree node exchanges none of these messages (asserted by the loopback in tests). *(2026-11-07, orchestrator, completeness check: the loopback-assertion seam, `observeRealmLoopbacks` in `realm-channel.ts`, went with 6002 (`4312188ab`) together with the loopback; the realm protocol itself no longer exists, and `rg` finds no realm message or loopback in `apps/web/src`, so the condition holds by construction.)*

## Notes

- **What each message became for an in-tree node (2026-11-07).** The window's side is `useRealmRequests(nodeId, send, shown, { inTree: true })` (`components/federation/realm-requests.tsx`, new `RealmRequestsOptions`); the realm side is `WorkspaceRealmHost` with `channel.kind === "loopback"`. Realm documents (desktop views and browser frames) are unchanged.
  - `sidebar` (both ways): not sent; the in-tree toolbar and the window read and write `uiChromeStore` (one store in one document). Commit d54c3e5b5.
  - `filesPanel` (both ways): not sent; `filesPanelChromeStore` (3007) is read and toggled in place. 9c3f581db.
  - `grouping`: not sent; `LeafModeCoordinatorGate` reads the window's grouping from `useWindowGrouping()` (new, `components/federation/useWindowGrouping.ts`: `realmGroupingFor(sortMode, machineViewStore.grouping, phone)`) when its scope is an in-tree leaf, `realmShellStore` otherwise. `useRealmRequests` uses the same hook. d6fbf1eb3.
  - `visibility`: not sent. The document's visibility is the window's; whether the node is shown is the window's selection, which the scope's tier follows (4002's lifecycle manager; only it calls `setTier`). 5df864ec4.
  - `select`: not sent. The host reads `remoteWorkspaceStore.requests[scope.nodeId]` (the window's node-qualified request; `open` already moved `windowScope.select`) and applies it with the scope's `uiStore` actions, as 3006 asks for user navigation; dialogs open through `openDialog(…, scope.nodeId)` (3017's node-qualified `appDialogStore`). 862b5606f.
  - `selection`: not sent. The scope's `uiStore` already moves the window's one selection (3006); the host adds what a realm's report added, the Home flag and the window's recents (`noteInTreeSelection`: `windowScope.select` + `noteNodeSelectionRecents`). d0d1b9311.
  - `open`: never crossed a loopback (`openMachineWorkspace` runs in the window's document, where `isWorkspaceRealm()` is false); comment in `open-workspace.ts` and a test. 6086e3bb0.
  - `ready`: the host does not post it; the window side marks an in-tree document ready in a layout effect once its `send` exists (the realm side subscribes in its passive effects, which run before the parent's, and the loopback delivers in a later microtask), so 5002's `panel` still arrives. a061b3a66.
- **Dialog gating (2026-11-07).** `dialogHydrated(request, NodeDialogHydration)` (exported from `WorkspaceRealmHost.tsx`) is the one gate, on the node's own stores: Add Project waits for the projects; New Environment also for config and the first Docker probe; a project dialog for the project list to be live (loaded, not loading), Delete Project also for environments, Repository Settings also for config; an environment's dialogs for the environment. The same predicate decides when the dialog components show.
- **Decision: in-tree request memory per scope.** Options: (a) the host's refs only (a remount re-applies the latest request, so Try again or 4002's parked document reopened a one-shot dialog); (b) the realm's `restart()` rule (strip dialogs after `ready`), which needs `ready`; (c) remember the last applied seq per `NodeScope` (`WeakMap`). Chosen (c): a host remounted on the same scope resumes from the node's own selection and does not reopen a dialog; a new scope (after the grace period) applies the latest request, as a fresh realm document does from its URL. Tested in `WorkspaceRealmHost.paths.test.tsx`.
- **Decision: the request stays in `remoteWorkspaceStore`.** Applying a request directly in `openMachineWorkspace` was the alternative, but the scope may not be open yet (`holdInTreeScope` is async) and the node's stores may not have hydrated, so the pending request needs a holder; `requests[nodeId]` already is the window's node-qualified one and goes with realms in 6002's cleanup of the store.
- **Bug-report flag.** The host reads the flag from the window's request; 5003 (commit 074bd2719) made it open the window's sheet on the node's scope (`openSheet(scope.nodeId)`), and `openBugReport` no longer sets the flag for an in-tree node. Covered here by a test (2efbd3851).
- **Tests box.** The tests drive the entry points the surfaces call, with the specs they pass: a sidebar environment row and ⌘K's result (`openMachineWorkspace`, ⌘K with `projectLandingBoardTab`), a coordinator work target (`openCoordinatorWorkTarget` remote → worker tab on the leaf's scope), every `REALM_DIALOGS` entry plus Add Project and New Environment (each waiting for its hydration), and a cross-node open from inside the workspace (the leaf-mode gate's "Open the coordinator on …"). That the rows and the search call those entry points with those specs is already covered by `remote-row-parity`, `ProjectSearchBar.federation` and `project-landing` tests, so they are not clicked again here.
- **Done when.** `observeRealmLoopbacks(observer)` (`lib/federation/realm-channel.ts`, test seam; returns the stop) reports every message any loopback carries. `InTreeWorkspace.direct.test.tsx` asserts per message, and a final scenario (open, navigate, dialogs, chrome toggles, hide and show) asserts none of the eight crosses. `panel`/`titleBar` (5002) are outside this item.
- **Effect.** Not used: these are synchronous store reads and writes and one `WeakMap`; the scope lifetime they read is already Effect-backed.
- **Outside the file set (minimal).** `components/projects/LeafModeCoordinatorGate.tsx` (grouping source) and its test; `lib/federation/open-workspace.ts` (comment); `docs/development/node-scopes.md` (the loopback row).
- **For the orchestrator.** (1) `requestGraphRunView` (`lib/graph-run-navigation.ts`) is a window-global listener set, so a graph-run work target applied in an in-tree node's scope reaches whichever run-view opener listens, possibly the command node's. Worth a scope key (4007 or 3011's follow-up). (2) Once 6001 makes in-tree the default, `realmShellStore`, the realm side's message handlers and `useRealmRequests`' realm branches are realm-only code for 6002.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): replaced the eight navigation messages for in-tree nodes with direct reads and writes, one commit each (d54c3e5b5 sidebar + loopback observer, 9c3f581db filesPanel, d6fbf1eb3 grouping, 5df864ec4 visibility, 862b5606f select + `dialogHydrated`, d0d1b9311 selection, 6086e3bb0 open, a061b3a66 ready + done-when test), then tests 2efbd3851 and bab997752 and docs cfbf7500c. Tests: `InTreeWorkspace.direct.test.tsx` 17 pass (new), `WorkspaceRealmHost.paths.test.tsx` 10 pass (loopback path now asks through the window's store; remount resume), `leaf-mode-coordinator-gate.test.tsx` 24 pass (1 new). Focused web suites (`components/federation`, `components/projects`, `lib/federation`, `stores`, `components/layout`, `components/sidebar`, `coordinator-work-navigation`): 2563 pass, 0 fail. Web typecheck clean; fmt and oxlint clean on touched files. `tests/unit/source-guards.test.ts`: only the known baseline findings in backend, bridge, e2e and one hook test, none in touched files.
- 2026-11-07 (orchestrator, completeness check): split Work box 1; "keep realm behaviour for realm nodes" marked superseded (no realm nodes since 6002/6003). Noted on the Done-when box that the loopback-assertion seam went with 6002 and the realm protocol no longer exists.
