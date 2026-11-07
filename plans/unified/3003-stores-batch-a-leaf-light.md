---
id: 3003
title: "Convert the light per-node stores (batch A)"
phase: 3
plan: "§12 Phase 3.1"
status: not-started
depends_on: [3001, 3002]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3003 · Convert the light per-node stores (batch A)

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix A](../../docs/reports/unified-federation.md#appendix-a-store-classification)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md)
- **Parallel with:** [3004](3004-project-and-environment-stores.md), [3005](3005-config-layering.md), [3011](3011-workflow-stores-a.md), [3012](3012-workflow-stores-b.md) and the other independent store items
- **Size:** M (one PR per store or a pair)
- **Track:** S (scopes)

## Goal

Convert the stores with the fewest imperative sites, to settle the recipe and the test helper.

## Stores (LOC, imperative sites total/in `.ts`; verified 2026-11-07)

| Store | LOC | Imperative sites (total/`.ts`) | Notes |
|---|---|---|---|
| `environmentDiffStore` | 84 | 0 | |
| `worktreeSnapshotStore` | 121 | 0 | |
| `agentActivityStore` | 62 | 0 | |
| `prMonitorStore` | 102 | 2 | |
| `multiReviewStore` | 30 | 19/13 | includes `multi-review-persistence.ts` (182 LOC, 2 module singletons) |
| `agentModelCatalogStore` | 95 | 14/13 | includes `agent-model-catalog-cache.ts` (11 sites) |
| `claudeOptionsStore` | 41 | 1 | already done in [3001](3001-scoped-store-shim-and-ratchet.md) |
| `tabLaunchStore` | 105 | 9/9 | includes `tab-launch.ts` (165 LOC, 3 module singletons) |

## Work

For each store:

- [ ] Change the definition to `defineScopedStore`, with backend calls through `createXApi(scope.client)`.
- [ ] Move imperative sites whose scope is known to `scope.store(def)`; leave the rest on the shim.
- [ ] Turn module singletons in the companion modules into `defineScopedService` or into state on the scope.
- [ ] Switch tests to `renderInNodeScope` with a `FakeNodeClient` instead of stubbing `window.orkestrator`.
- [ ] Update the shim baseline.

## Tests

- [ ] Per store: two scopes keep independent state, and a test proves calls go to the scope's client.

## Done when

- [ ] Every store in the batch is converted, and the batch's shim count is recorded in Notes (target 0 for these).
