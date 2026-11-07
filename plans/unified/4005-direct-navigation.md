---
id: 4005
title: "Replace navigation realm messages with direct calls"
phase: 4
plan: "§12 Phase 4.3 and Appendix C"
status: not-started
depends_on: [4001, 3006]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Replace each message for in-tree nodes, one per commit. Keep realm behaviour for realm nodes.
- [ ] `WorkspaceRealmHost` dialog gating becomes hydration checks on the scope (a project dialog waits for the project list to be live, not for `ready`).
- [ ] Coordinator work targets and the bug report flag from [0001](0001-realm-request-drift.md) work in-tree.

## Tests

- [ ] For an in-tree node: sidebar click, ⌘K, a work-target open, every dialog in `RealmDialog`, and cross-node open from inside a workspace.

## Done when

- [ ] An in-tree node exchanges none of these messages (asserted by the loopback in tests).
