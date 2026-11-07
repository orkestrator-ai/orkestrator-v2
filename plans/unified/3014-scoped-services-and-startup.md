---
id: 3014
title: "Per-scope services and startup"
phase: 3
plan: "§7.4 and §12 Phase 3.7"
status: not-started
depends_on: [3001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3014 · Per-scope services and startup

- **Report:** [§7.4 Services and module state](../../docs/reports/unified-federation.md#74-services-and-module-state), [Appendix B](../../docs/reports/unified-federation.md#appendix-b-module-singletons)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md)
- **Blocks:** [4001](4001-in-tree-workspace-seam.md), [4002](4002-hydration-tiers-and-budgets.md)
- **Parallel with:** the store items, each of which moves its own handlers here
- **Size:** M
- **Track:** S (scopes)

## Goal

What `App.tsx` starts once for the one backend is started per scope, at the tier that needs it, and each service has an explicit stop (invariant 15).

## Current state (verified 2026-11-07)

`App.tsx` (1,761 LOC) :355-369. The report says :353-365 and omits `startDataSavingReadPolicy`.

| Line | Call | Stop |
|---|---|---|
| 355-363 | `startResourceSync({…})` (`lib/resource-sync.ts:279`, 606 LOC, 7 singletons) | returns stop |
| 364 | `startStoreResourceSync()` (`store-resource-sync.ts:105`, 703 LOC, 35 sites) | yes |
| 365 | `startTransportConnectivity()` (`transport-connectivity.ts:102`, 125 LOC) | yes; no-op without `eventStreamConnection` |
| 366 | `startDataSavingReadPolicy()` (`lib/data-saving.ts:14`) | yes |
| 367 | `startPaneLayoutPersistence()` | yes |
| 369 | `startBuildPipelineCompletionNotes()` | yes |

Also: `migrateLegacyBuildPipelines` (:370), `startCoordinatedPoll` (:701), and `useHydrateOncePerEnvironment` for prompt queues and Multi Review.

`read-coordinator.ts` (1,186 LOC, 3 singletons) is shared: visibility and data-saving policy belong to the window, and reconnect bookkeeping belongs to each node.

## Work

- [ ] Define each started service with `defineScopedService`. Start them for the command scope at the same point in `App.tsx`. A later "warm" scope starts the light ones; see the tier table in [4002](4002-hydration-tiers-and-budgets.md).
- [ ] `store-resource-sync`: split into per-store handler registrations that run inside the scope. Each store item moves its handlers here; this item provides the mechanism and moves the remainder.
- [ ] `transport-connectivity`: per node, plus a window aggregate for the title bar.
- [ ] `read-coordinator`: the window part (visibility, `setHostHidden` from [0003](0003-hidden-realm-visibility.md), data saving) stays a singleton. Per-node reconnect state moves onto the scope.
- [ ] `startCoordinatedPoll` and the hydrate-once hooks: per scope.
- [ ] Every service handles rejection on its scope's `AbortSignal` (§10.3).

## Tests

- [ ] Each service: start, stop and restart, with no timer or listener left after stop (checked in `afterEach`).
- [ ] A failing service marks only its scope as failed.

## Done when

- [ ] `App.tsx` starts services only through the command scope, and the module `start*` singletons are gone or explicitly window-level.
