---
id: 6001
title: "In-tree by default, realms as a one-release rollback"
phase: 6
plan: "§12 Phase 6.1 and 6.5"
status: not-started
depends_on: [4006, 5001, 5002, 5003, 5004, 0006]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Flip `inTreeNodes` to "all", and invert the setting to `useRealmsForRemoteMachines` (default off).
- [ ] Release notes say how to use the rollback and that it is temporary.
- [ ] Watch the content-free counters (`node-scope.shim-under-leaf`, scope `failed` events, renderer OOM reports) for the release, and record what was seen.

## Done when

- [ ] One release has shipped with in-tree as default, with no blocking regression recorded. The user decides when to proceed to deletion.
