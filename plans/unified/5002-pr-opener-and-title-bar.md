---
id: 5002
title: "PR opener, title-bar meters and popovers from the scope"
phase: 5
plan: "§9 and §12 Phase 5.2"
status: not-started
depends_on: [4001, 3007]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 5002 · PR opener, title-bar meters and popovers from the scope

- **Report:** [§9](../../docs/reports/unified-federation.md#9-cross-node-features), [Appendix C](../../docs/reports/unified-federation.md#appendix-c-the-realm-protocol-and-what-replaces-it)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md), [3007](3007-files-panel-split.md)
- **Blocks:** [6001](6001-in-tree-by-default.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

Opening a PR in the app works for any shown node. Title-bar meters and the agent popover are ordinary components fed by the shown scope.

## Current state (verified 2026-11-07)

- `lib/pull-request-opener.tsx:77`: `if (useRemoteWorkspaceStore.getState().active) return false;` (the function spans :73-83).
- `RealmTitleBar.tsx` (269 LOC) plus the `panel`, `panelDismissed` and `titleBar` messages: popovers drawn by the realm under window triggers, with seq, inset and focus handoff.
- `useMachineSystemUsage(nodeId)` already feeds `MachineCpuReadings`.

## Work

- [ ] The PR opener resolves the shown scope and opens in that scope's files panel. Delete the `active` early return for in-tree nodes.
- [ ] The title bar uses `useMachineSystemUsage(shownNodeId)` and ordinary popovers whose data comes from the shown scope. Replace `panel`, `panelDismissed` and `titleBar` for in-tree nodes.

## Tests

- [ ] PR opener with a leaf shown; meters switch with the shown node; popover focus returns to its trigger on dismissal.

## Done when

- [ ] None of the three messages is used for in-tree nodes.
