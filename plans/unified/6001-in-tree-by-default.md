---
id: 6001
title: "In-tree by default, realms as a one-release rollback"
phase: 6
plan: "§12 Phase 6.1 and 6.5"
status: in-progress
depends_on: [4006, 5001, 5002, 5003, 5004, 0006]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 6001 · In-tree by default, realms as a one-release rollback

- **Report:** [§12 Phase 6](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [4006](4006-multi-node-qualification.md), [5001](5001-attention-per-scope.md), [5002](5002-pr-opener-and-title-bar.md), [5003](5003-settings-bug-report-shortcuts-dialogs.md), [5004](5004-coordinator-and-portal-through-command-scope.md), [0006](0006-grant-scope-live-evidence.md)
- **Blocks:** [6002](6002-delete-web-realm-code.md), [6003](6003-delete-desktop-realm-code.md)
- **Size:** S
- **Track:** S (scopes)

## Goal

Every node renders in-tree by default. A setting brings realms back for one release in case of regressions.

## Work

- [x] Flip `inTreeNodes` to "all", and invert the setting to `useRealmsForRemoteMachines` (default off).
- [x] Release notes say how to use the rollback and that it is temporary.
- [ ] Watch the content-free counters (`node-scope.shim-under-leaf`, scope `failed` events, renderer OOM reports) for the release, and record what was seen. *(Not possible: no release ships between this item and 6002/6003; see Notes.)*

## Done when

- [ ] One release has shipped with in-tree as default, with no blocking regression recorded. *(Waived: approved by the user on 2026-11-07, in one combined PR; see Notes.)*
- [x] The user decides when to proceed to deletion. *(Decided: proceed now, in this PR.)*

## Notes

- **Gate and approvals (2026-11-07).**
  - Proceeding from 6001 to deletion (6002, 6003) without the one-release wait: approved by the user on 2026-11-07, in one combined PR.
  - 4006's Done-when is open because iPad memory with six warm nodes could not be measured on this host (no iPad; iOS simulator unavailable). The plan says that blocks 6001; the user asked for all items in one PR and approved going past 6001 to deletion, so this item proceeds with that box open and the iPad risk recorded: iOS gets 4002's lower budgets, the 2-minute suspend, suspend-on-hidden and the memory-warning hook. **Needs live evidence: iPad memory under in-tree default.** Also recorded as one bullet in the report's §15.
  - **The rollback exists only in this branch's intermediate commits.** 6002 and 6003 delete the realm code in this same PR, so the setting never ships in a release. The user approved removing it (the plan's one-release wait is waived). 6002 must delete `useRealmsForRemoteMachines`, `InTreeWorkspaceSection`, the `docs/development/releasing.md` pending note's rollback paragraph (keep the first paragraph: workspaces open in the window), and the "rollback" sentences in `node-scopes.md`, `command-nodes.md` and `federation.md`.
- **API (2026-11-07).** `stores/inTreeNodesStore.ts` (name kept so 6002's deletion list stays valid): `useInTreeNodesStore` with `useRealmsForRemoteMachines: boolean` (default `false`) and `setUseRealmsForRemoteMachines(on)`, persisted per window under `windowStorageKey("use-realms-for-remote-machines")` (only an explicit `true` turns it on); `nodesInTree(state?) → boolean`; `useNodesInTree() → boolean`. Removed: `nodes`, `setInTree`, `isInTreeNode`, `useInTreeNode`, `normalizeInTreeNodes`, `MAX_IN_TREE_NODES` and the `VITE_ORKESTRATOR_IN_TREE_NODES` development override (with every node in-tree it has nothing to add). 4001's `in-tree-nodes` key is no longer read, so a stored empty list does not mean realms; the stale key is left in storage (a few bytes; 6002 drops the module).
- **Decision: one window-wide switch, not a per-node list (2026-11-07).** Options: (a) keep 4001's per-node list and add "all" as its default, with per-node opt-out; (b) one boolean, `useRealmsForRemoteMachines`, as the item names it. Pros of (a): finer rollback. Cons: two settings to explain, a per-node realm/in-tree mix that 6002 removes anyway, and every consumer still asks per node. Chosen: (b). The rollback is a whole-window "go back", the switch sits in each machine's dialog under the same "Workspace in this window" heading 4001 used, and says it applies to every machine in the window.
- **Every host.** Nothing gates in-tree on the platform: desktop, browser and the iOS app (the browser path in a WKWebView) all read `nodesInTree()`. iOS gets 4002's host defaults through `detectLifecycleHost`.
- **Consumers.** `RemoteWorkspaceRegion` (default selection: `InTreeWorkspace` unless the rollback is on), `remoteWorkspaceStore.open` (`MAX_OPEN_REALMS` applies only under the rollback; in-tree nodes are bounded by 4002's lifecycle), `window-attention.ts` (`realmNodes()` is empty unless the rollback is on), `open-bug-report.ts`, `ShownNodeTitleBar.tsx`, `BugReportSheet.tsx`. Behaviour fix needed by the flip: `BugReportSheetHost` treated "in-tree" as "a scope is opening"; with every node in-tree that would leave a sheet for an unopened node waiting forever, so "opening" is now in-tree **and** held by the region (`remoteWorkspaceStore.realms`), which `openBugReport` guarantees.
- **Counters (Work box 3, left open).** The counters exist and are content free: `web.node-scope` `shim-under-leaf` (4004, `lib/node-scope/shim-under-leaf-guard.ts`), the scope's `service.failed` warning and `NodeScopeHealth` `failed` (`lib/node-scope/node-scope.ts`), `web.node-scope` `workspace.render-failed` (`NodeErrorBoundary`), and on the desktop `renderer-gone` with `reason: "oom"` (`electron/renderer-diagnostics.ts`). Watching them "for the release" cannot happen, because no release ships between this item and 6002/6003. The only in-tree-by-default evidence before deletion is 4006's live run (`e2e/agent-testing/multi-node-window.spec.ts`, which asserts `orkestratorShimGuard.uses()` is `[]`); see 4006's Notes for what it saw.
- **Tests and the realm suites.** Realm-only suites now run under the rollback (`useRealmsForRemoteMachines: true` in `beforeEach`): `RemoteWorkspaceRegion.test.tsx`, `remoteWorkspaceStore.test.ts` and `open-bug-report.test.ts`, plus single realm cases in `AppShell.test.tsx`, `useRemoteNodeAttention.test.tsx` and `window-attention.test.ts`. `MobileAppShellLayout.test.tsx`'s remote report case now expects the in-tree path (the window's sheet on the node, no realm request). 6002 deletes the realm cases.
- **Visible change.** Settings → Machines → a machine → "Workspace in this window": description of the current mode, and a switch "Use separate workspace windows (realms)" with help text that says it applies to every machine in the window, that work keeps running, and that it is temporary. Rendered from the component in headless Chromium (harness `output/visual-previews/6001-harness`, script `output/agent-testing/6001/shoot.ts`): `output/visual-previews/6001-settings-machine-default.png`, `6001-settings-machine-rollback.png`, `6001-settings-machine-default-narrow.png` (390 px).
- **Docs.** `docs/development/releasing.md` (pending release note), `docs/development/node-scopes.md` ("A node's workspace in the window's tree"), `docs/architecture/command-nodes.md` ("Opening an environment on another node": in-tree default, realms behind the rollback), `docs/architecture/federation.md` (`MAX_OPEN_REALMS` paragraph). No `version-compatibility.md` row: a rollback switch, not version skew.
- **Effect.** Not used: a persisted boolean and a selector. Nothing here has a lifetime, retry or typed failure.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): made in-tree the default for every node and replaced 4001's per-node list with the window-wide rollback `useRealmsForRemoteMachines` (default off) in Settings → Machines; moved every consumer to `nodesInTree()`/`useNodesInTree()`; fixed `BugReportSheetHost`'s "opening" for the new default; realm suites run under the rollback; pending release note and docs; screenshots. Recorded the approvals, the waived release wait, the iPad risk and the counters.
