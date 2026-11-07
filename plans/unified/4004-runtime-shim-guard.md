---
id: 4004
title: "Runtime guard: no command-scope shim calls under a leaf"
phase: 4
plan: "§7.3 guard 2 and §12 Phase 4.5"
status: not-started
depends_on: [4001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 4004 · Runtime guard: no command-scope shim calls under a leaf

- **Report:** [§7.3](../../docs/reports/unified-federation.md#73-the-migration-shim-and-its-ratchet)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md) (and the hook from [3001](3001-scoped-store-shim-and-ratchet.md))
- **Parallel with:** [4002](4002-hydration-tiers-and-budgets.md), [4003](4003-snapshot-first-rehydration.md), [4005](4005-direct-navigation.md)
- **Size:** S
- **Track:** S (scopes)

## Goal

A misrouted call, where code acting for a leaf reads or writes the command node through a shim, fails loudly in development and tests and is counted in production.

## Work

- [ ] While any in-tree leaf scope is mounted, `noteShimUse(storeName)` throws in `development` and `test` when the store is in the workspace-subtree set from [3013](3013-pane-layout-store.md). In production it records a content-free `node-scope.shim-under-leaf` log event with the store name only.
- [ ] Stores outside the workspace subtree (window-level or command-only) are exempt. List them explicitly.
- [ ] Add the guard to the multi-node e2e in [4006](4006-multi-node-qualification.md) so it runs on real flows.

## Tests

- [ ] With a leaf mounted, a shim call on a workspace store throws in tests; an exempt store does not; with no leaf mounted, nothing throws.

## Done when

- [ ] The guard is on, and the full suite and the multi-node e2e pass with it.
