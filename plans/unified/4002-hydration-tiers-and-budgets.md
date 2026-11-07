---
id: 4002
title: "Hydration tiers, suspension and byte budgets"
phase: 4
plan: "§8.1-8.2 and §12 Phase 4.4"
status: not-started
depends_on: [4001, 0004]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 4002 · Hydration tiers, suspension and byte budgets

- **Report:** [§8.1 Tiers](../../docs/reports/unified-federation.md#81-tiers), [§8.2 Budgets per host](../../docs/reports/unified-federation.md#82-budgets-per-host)
- **Decision:** 13.3 B (byte budgets with tiers)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md), [0004](0004-measurement-report.md) (defaults)
- **Blocks:** [4006](4006-multi-node-qualification.md), [5005](5005-multiplexed-relay-stream.md)
- **Parallel with:** [4003](4003-snapshot-first-rehydration.md), [4004](4004-runtime-shim-guard.md), [4005](4005-direct-navigation.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The memory budget, not a count, decides how many nodes stay warm. Eviction drops data (one environment's transcript), not whole apps. This replaces `MAX_OPEN_REALMS` and `DEFAULT_MAX_VIEWS` for in-tree nodes.

## Work

- [ ] A lifecycle manager on `WindowScope` with tiers summary → warm → live → suspended, as in the §8.1 table. Each scope records `lastShown`.
- [ ] Transitions:
  - **Open:** summary → warm → live.
  - **Switch away:** live → warm. Heavy data is released to the window budgets on demand.
  - **Warm, hidden past `NODE_SUSPEND_AFTER_MS`:** the scope suspends. Streams close, the cursor is kept, and services stop. A suspended scope is also told it is host-hidden (`setHostHidden`).
  - **Switch back:** the scope resumes from the cursor. A gap gives `gateway.reconcile-required` and stores re-read their snapshots (invariants 3, 4, 7 and 8).
- [ ] Pressure order: drop heavy data of the least recently shown live nodes, then suspend warm nodes, then dispose suspended scopes back to summary. Never touch the shown node.
- [ ] Per-host defaults from [0004](0004-measurement-report.md):
  - desktop 15 min;
  - browser 5 min;
  - iOS 2 min, and immediately on `visibilitychange` hidden.
  - Budgets: `measureUserAgentSpecificMemory` where available, a fixed conservative fallback on iOS.
- [ ] Desktop main releases idle node scopes ([2006](2006-desktop-node-scopes.md)) when the renderer disposes a scope.
- [ ] Optional: a memory-warning hook from the iOS app's WebView, mapped to the pressure path.

## Tests

- [ ] The tier state machine under each transition; the pressure order; the shown node is never evicted.
- [ ] Resume after a gap triggers resync rather than replaying stale events.
- [ ] Timers are stopped on dispose.

## Done when

- [ ] Six fake nodes cycle through switching with bounded memory in a test, and the budgets are configurable per host.
