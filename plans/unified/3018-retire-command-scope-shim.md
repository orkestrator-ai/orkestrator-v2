---
id: 3018
title: "Retire the command-scope store shim"
phase: 3
plan: "§7.2, §7.3 and §12 Phase 3"
status: not-started
depends_on: [3013, 4004]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3018 · Retire the command-scope store shim

- **Report:** [§7.2 Scoped store definitions](../../docs/reports/unified-federation.md#72-scoped-store-definitions), [§7.3 The migration shim and its ratchet](../../docs/reports/unified-federation.md#73-the-migration-shim-and-its-ratchet)
- **Depends on:** [3013](3013-pane-layout-store.md) (last store converted), [4004](4004-runtime-shim-guard.md) (runtime guard)
- **Blocks:** [6004](6004-documentation.md)'s "node-scopes.md final form, with the shim removed" box
- **Size:** M
- **Track:** S (scopes)

## Goal

The per-node stores are reached only through a scope. The deprecated command-scope statics and the provider-less fallback of `scopedStoreHook` are gone, so a call made on behalf of a leaf can no longer reach the command node by accident.

## Current state (verified 2026-11-07)

Found while doing [6004](6004-documentation.md):

- All 39 per-node stores export `scopedStoreHook(def)`. Its hook falls back to the command scope outside a provider and records the use; its `getState`/`setState`/`subscribe`/`getInitialState` statics act on the command scope.
- The production shim baseline (`tests/source-guards/baseline.json`, guard `scoped-store-shim`) is 0, so production code no longer uses the statics.
- Many test suites still seed stores through the statics and render without a provider (3013 counted about 70 for `pane-layout` alone; 3003 moved 48 suites to `renderInAppCommandScope`).

## Work

- [ ] Move every test that seeds or reads a store through its statics to an explicit scope (`renderInNodeScope` / `renderInAppCommandScope`, `scope.store(def)`), store by store.
- [ ] Make each converted store's hook the strict `useScopedStore(def, selector)` and remove its statics; remove `scopedStoreHook`'s fallback and `noteShimUse` once no store uses them. Keep [4004](4004-runtime-shim-guard.md)'s guard only if something still feeds it; otherwise delete it with a note.
- [ ] Retire the `scoped-store-shim` source guard (or keep it as a guard that a static never comes back), and update `docs/development/node-scopes.md`.

## Tests

- [ ] The web suite and the root unit suites pass with no store statics left.
- [ ] A test proves a hook used outside a provider throws in development and tests.

## Done when

- [ ] No per-node store exports command-scope statics, and no hook falls back to the command scope.

## Notes

- 2026-11-07 (orchestrator): created from 6004's open box. The report's §7.3 described the shim as a migration aid with a ratchet; this item completes the migration.

## Work log
