---
id: 4006
title: "Multi-node qualification on desktop, browser and iPad"
phase: 4
plan: "§12 Phase 4.6 and exit"
status: not-started
depends_on: [4007, 4002, 4003, 4004, 4005, 2009]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 4006 · Multi-node qualification on desktop, browser and iPad

- **Report:** [§12 Phase 4](../../docs/reports/unified-federation.md#12-migration-plan), [§14 Risks](../../docs/reports/unified-federation.md#14-risks)
- **Depends on:** [4002](4002-hydration-tiers-and-budgets.md), [4003](4003-snapshot-first-rehydration.md), [4004](4004-runtime-shim-guard.md), [4005](4005-direct-navigation.md), [2009](2009-desktop-previews-and-gateway-snapshot.md)
- **Blocks:** [6001](6001-in-tree-by-default.md)
- **Size:** M–L
- **Track:** S (scopes), critical path

## Goal

Evidence that in-tree nodes have feature parity with realms and fit the memory budget on every host. That evidence is the gate for making in-tree the default.

## Current state (verified 2026-11-07)

- The e2e to replace is `e2e/agent-testing/workspace-realm-electron.spec.ts`, which has 1,039 lines (the report says 958). Related specs: `relayed-events-electron.spec.ts`, `renderer-permissions-electron.spec.ts`, `KeyboardShortcuts.spec.ts`.
- `scripts/qa-leaf-workspace-browser.ts` (518 lines) is the browser QA script to replace.

## Work

- [ ] A new multi-node e2e, `e2e/agent-testing/multi-node-window.spec.ts`, on desktop (Electron) and browser (Playwright), against `dev:test` profiles with leaves attached. It covers:
  - opening each node in-tree;
  - the inactive-environment cycle from `AGENTS.md` for a leaf (start work, switch away, let it finish, return, reload);
  - reload rehydration, including a snapshot-first paint;
  - six-node switching with budget eviction;
  - preview z-order and focus with previews from two nodes in one window (desktop);
  - grant lapse and reopen without a reload;
  - attention from a hidden node.
- [ ] The parity suites run on both the realm path and the in-tree path.
- [ ] iPad: memory with six warm nodes against the budget from [0004](0004-measurement-report.md); a jetsam-free session of N switches. Record in the measurements report.
- [ ] Record evidence: profiles, commands, pass counts and any skipped flow with its reason.

## Done when

- [ ] Every flow passes on desktop and browser, iPad memory is within budget, and the evidence is linked here. Anything not run is listed under "needs live evidence" and blocks [6001](6001-in-tree-by-default.md).
