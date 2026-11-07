---
id: 5003
title: "Settings, bug report, shortcuts and dialogs by direct calls"
phase: 5
plan: "§9 and §12 Phase 5.3"
status: not-started
depends_on: [4001, 3017]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 5003 · Settings, bug report, shortcuts and dialogs by direct calls

- **Report:** [§9](../../docs/reports/unified-federation.md#9-cross-node-features), [Appendix C](../../docs/reports/unified-federation.md#appendix-c-the-realm-protocol-and-what-replaces-it)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md), [3017](3017-window-stores-node-qualified.md)
- **Blocks:** [6001](6001-in-tree-by-default.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The `settings`, `bugReport` and `shortcut` messages disappear for in-tree nodes. Bug reports and node dialogs run against an explicit scope.

## Work

- [ ] `settings` {section} → `requestGlobalSettings(section)`.
- [ ] `bugReport` {nodeId} → `BugReportSheet scope={scope(nodeId)}`. The report is created and uploaded through that node's client.
- [ ] `shortcut` {id} → one key router. Shortcuts typed inside an in-tree workspace reach the window handler directly. Update `app-shortcuts.ts` and `settings-navigation.ts`, and delete their realm branches for in-tree nodes.
- [ ] Node dialogs open under the node's scope, with hydration checks: Add Project, New Environment, Repository Settings, Delete Project, environment Settings and Rebuild.

## Tests

- [ ] A bug report for a leaf reaches the leaf's backend; every shortcut in `KeyboardShortcuts.spec.ts` works with a leaf shown; each dialog acts on the right node.

## Done when

- [ ] None of the three messages is used for in-tree nodes.
