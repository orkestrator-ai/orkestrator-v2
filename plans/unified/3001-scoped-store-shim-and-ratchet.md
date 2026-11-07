---
id: 3001
title: "The command-scope shim and its shrink-only ratchet"
phase: 3
plan: "§7.3 and §12 Phase 3"
status: not-started
depends_on: [2001, 2010]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3001 · The command-scope shim and its shrink-only ratchet

- **Report:** [§7.3 The migration shim and its ratchet](../../docs/reports/unified-federation.md#73-the-migration-shim-and-its-ratchet)
- **Decision:** 13.2 B (explicit scope plus context, with a temporary shim)
- **Depends on:** [2001](2001-node-scope-core.md), [2010](2010-command-scope-wiring.md)
- **Blocks:** every store item in Phase 3
- **Size:** S–M
- **Track:** S (scopes)

## Goal

Stores can be converted one at a time. Any static `useXStore.getState/setState/subscribe` call left behind is counted per store, and the count can only fall.

## Current state (verified 2026-11-07)

- There are 655 imperative `use<X>Store.(getState|setState|subscribe)(` sites outside `*.test.ts(x)`. That figure counts calls a store makes on itself. About 30 of them are in test-support or fixture files (`src/test/*`, `*-test-support*`), leaving about 625 in production. The report says 639.
- There are 846 hook-selector calls.
- The `@/stores` barrel re-exports about 22 stores and has 107 importers, so counting importers by path undercounts.
- `components/terminal/PersistentTerminal.tsx` is detected as binary by plain grep. Scan it with the oxc parser (`tests/source-guards/scan.ts`), not grep.

## Work

- [ ] `defineScopedStore` returns a def. The converted module exports:
  - the def;
  - the hook, keeping its name (`useEnvironmentStore(selector)` → `useScopedStore(def, selector)`);
  - the deprecated statics `getState`, `setState` and `subscribe` on the hook. These resolve the **command scope** and are marked `@deprecated`.
- [ ] Source guard `scoped-store-shim`: per store, per file, it counts static calls on a converted store's hook. It resolves barrel re-exports and identifies the store from its import, not from the identifier's spelling. The baseline lives in `tests/source-guards/baseline.json`.
- [ ] Unconverted stores are not counted; a store enters the guard when its item converts it. Commit the expected total per store in this item's Notes as stores convert.
- [ ] Development hook for the runtime guard: the shim calls `noteShimUse(storeName)`, which does nothing until [4004](4004-runtime-shim-guard.md) turns it on.
- [ ] Document the conversion recipe in `docs/development/node-scopes.md` (new). It covers the def, the hook, imperative sites, tests with `renderInNodeScope`, and updating the baseline.

## Tests

- [ ] Guard fixtures: a barrel import, an aliased import, a direct import, and a call inside a test file (not counted).
- [ ] The baseline can only shrink: an increase fails, and a stale entry fails until the baseline is regenerated.

## Done when

- [ ] The guard and docs are merged, and one trivial store (`claudeOptionsStore`, 1 site) is converted as the worked example.
