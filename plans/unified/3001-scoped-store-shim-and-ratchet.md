---
id: 3001
title: "The command-scope shim and its shrink-only ratchet"
phase: 3
plan: "§7.3 and §12 Phase 3"
status: done
depends_on: [2001, 2010]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] `defineScopedStore` returns a def. The converted module exports:
  - the def;
  - the hook, keeping its name (`useEnvironmentStore(selector)` → `useScopedStore(def, selector)`);
  - the deprecated statics `getState`, `setState` and `subscribe` on the hook. These resolve the **command scope** and are marked `@deprecated`.
- [x] Source guard `scoped-store-shim`: per store, per file, it counts static calls on a converted store's hook. It resolves barrel re-exports and identifies the store from its import, not from the identifier's spelling. The baseline lives in `tests/source-guards/baseline.json`.
- [x] Unconverted stores are not counted; a store enters the guard when its item converts it. Commit the expected total per store in this item's Notes as stores convert.
- [x] Development hook for the runtime guard: the shim calls `noteShimUse(storeName)`, which does nothing until [4004](4004-runtime-shim-guard.md) turns it on.
- [x] Document the conversion recipe in `docs/development/node-scopes.md` (new). It covers the def, the hook, imperative sites, tests with `renderInNodeScope`, and updating the baseline.

## Tests

- [x] Guard fixtures: a barrel import, an aliased import, a direct import, and a call inside a test file (not counted).
- [x] The baseline can only shrink: an increase fails, and a stale entry fails until the baseline is regenerated.

## Done when

- [x] The guard and docs are merged, and one trivial store (`claudeOptionsStore`, 1 site) is converted as the worked example.

## Notes

- **Decision 13.1 confirmed before Phase 3: approved by the user on 2026-11-07, in one combined PR.** Architecture C (one tree, per-node store instances) is the basis for every Phase 3 store item.
- **API (2026-11-07).** `apps/web/src/lib/node-scope/scoped-store-shim.ts`:
  - `scopedStoreHook<S>(def) → ScopedStoreHook<S>`. It is callable as `()` or `(selector)` like a zustand hook, and carries `def` and the `@deprecated` statics `getState`, `setState`, `subscribe` and `getInitialState`. Each static acts on `getWindowScope().commandScope().store(def)` at the time of the call.
  - `commandScopeStore(def) → StoreApi<S>` (what the statics use).
  - `noteShimUse(store, via: ShimUseKind)`, where `ShimUseKind` is `"getState" | "setState" | "subscribe" | "getInitialState" | "hook-without-provider"`. It is a no-op until an observer is installed.
  - `setShimUseObserver(observer | null) → restore`, for [4004](4004-runtime-shim-guard.md) and tests.
  - Additive in `providers.tsx`: `useOptionalNodeScope(): NodeScope | null`, so the shim can tell when it falls back.
  - `defineScopedStore`, `useScopedStore` and `scope.store(def)` are 2001's and are unchanged.
- **Decision: the hook falls back to the command scope outside a provider (2026-11-07).** Options:
  - (a) The converted hook is the strict `useScopedStore(def, selector)`, as in report §7.2. It throws outside a provider in tests and development. For `claudeOptionsStore` alone that breaks every TerminalContainer suite (`view`, `helpers`, `overlays`, `render-count`, `notes`), `PersistentTerminal` and every suite rendering a parent of them with plain `render`. Larger stores reach hundreds of files.
  - (b) `scopedStoreHook`: inside a provider it is exactly `useScopedStore`; outside one it reads the app's command scope, the same instance the statics use, and calls `noteShimUse(name, "hook-without-provider")`.

  Chosen: (b). It matches 3017's `useScopesWithCommandFallback` precedent, it is today's production behaviour (2001's fallback), and the fallback is visible to 4004's runtime guard. A store item switches its hook to `useScopedStore` once its tests render in a scope ("Retiring the shim" in the recipe).
- **Deviation: `noteShimUse(storeName, via)`.** It takes a second argument, so 4004 can tell a static from a provider-less hook. The item text names only `storeName`.
- **Guard (`tests/source-guards/scoped-store-shim.ts`).** A production-source guard over `apps/web/src`, excluding test sources (`isTestSource`) and `src/test/**`.
  - **Registry.** `SHIMMED_STORES` (`{ store, module, hook }`) lists the converted stores. A repository test asserts that every `export const X = scopedStoreHook(` in production code is registered, and that every registration names a module with a `defineScopedStore<` def of that name. So a store enters the guard exactly when its item converts it, and unconverted stores are never counted.
  - **Resolution.** The store is found from the import: named, aliased (`as`) and namespace imports, resolved through `@/stores` or any re-exporting module (`export { … } from`, `export * from`, import-then-`export { … }`). `ShimmedStoreResolver` caches each module's exports until its source changes. A store module's calls on itself are counted. A same-named binding from another module is not.
  - **What is counted.** Member reads of `getState`, `setState`, `subscribe` and `getInitialState`, plus destructuring them.
  - **Per store, per file.** New in the scan infrastructure: `GuardVisitor.finish()` may return `{ offset, subject }` (`SubjectFinding`), `Finding.subject`, and `baselineKey(finding)` (`[subject] file`). `update-baseline.ts` prints per-subject totals (`subjectTotals`). `isTestSource` moved to `tests/source-guards/paths.ts` (re-exported from `scan.ts`), so a guard can use it without an import cycle through `scan.ts`.
  - **Options for per-store counting.** (a) Keyed entries in the existing per-guard map (chosen): there is one baseline file, the existing ratchet and messages work unchanged, and `--guard` works. (b) One guard id per store: `GUARD_IDS` is a closed `as const` tuple that the types depend on, so every store item would change the infrastructure. (c) A separate baseline file per store, which the item rules out ("lives in `baseline.json`").
- *(2026-11-07, orchestrator, completeness check: the per-store totals below are as of this item; at HEAD every store's total is 0: the `scoped-store-shim` entry of `tests/source-guards/baseline.json` is empty, `{}`.)* **Expected totals per store (commit as stores convert).**
  - `claude-options`: **1** shim use in 1 file (2026-11-07): `apps/web/src/App.tsx`, `useClaudeOptionsStore.getState().getOptions(environmentId)` in `ConnectedApp`'s `handleStartEnvironmentFromOverlay`, imported through the `@/stores` barrel.
- **Why the App.tsx site was not converted.** It sits under `CommandNodeScopeProvider`, so converting it is mechanical: `const claudeOptions = useNodeScope().store(claudeOptionsStore)`, then `claudeOptions.getState()` in the callback, adding it to the dependencies. App.tsx has another agent's uncommitted edits in this wave (3016, `noteRichContentConnection`), and a pathspec commit would have swept them in. Kept as the baseline's worked entry; the next item that touches `ConnectedApp` retires it.
- **The worked example.** `claudeOptionsStore` is `defineScopedStore<ClaudeOptionsState>("claude-options", () => …)`. `useClaudeOptionsStore = scopedStoreHook(claudeOptionsStore)` is exported from the module and from the `@/stores` barrel (with the def). Hook call sites (`App.tsx`, `CreateEnvironmentFlowDialog.tsx`, `TerminalContainer.view.tsx`) are unchanged. Its own test now opens explicit scopes and adds per-node isolation and shim-reaches-command-scope tests. The other suites' `useClaudeOptionsStore.setState/getState` (test files, not counted) still work, because outside a provider the hook and the statics share the command scope's instance.
- **Recipe.** `docs/development/node-scopes.md` (new): the pieces, the seven conversion steps (def, barrel, `SHIMMED_STORES` registration, hook sites, imperative sites by kind, `update-baseline.ts --guard scoped-store-shim`, validation), retiring the shim, and tests (explicit `WindowScope` for store tests, `renderInNodeScope` with `scope.store(def)` seeding for components, the provider-less fallback, `resetWindowScopeForTests`). Linked from `docs/README.md`, `docs/development/linting.md` ("Transports only through a scope", the guard entry), `docs/development/testing-guide.md` and `AGENTS.md` ("State Management").
- **Where Effect is used, and where not.** Not used. The shim is a synchronous zustand facade over 2001's scope (whose lifetime is already an Effect `Scope`), and React reads it synchronously. The guard is static test tooling. `noteShimUse` is a plain observer slot, because 4004 decides what a use means.
- **For the report.** §7.6's "a rule against importing a scoped store's static shim in new code" is this guard. It counts calls, not imports, because the hook import is legitimate. §7.3's "639" stands; the shim baseline grows only as stores convert.
- **Pre-existing failures.** `tests/unit/source-guards.test.ts`'s repository ratchet still fails only on the four test-source guards' findings in untouched test files. It has no finding or stale entry for `scoped-store-shim`, `direct-transport-import` or `window-orkestrator-direct`. The aggregate suite (`mise run test`) is left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `scopedStoreHook`, `commandScopeStore`, `noteShimUse` and `setShimUseObserver` (`lib/node-scope/scoped-store-shim.ts`), and `useOptionalNodeScope` (`providers.tsx`). Converted `claudeOptionsStore` (def plus shim hook, barrel export). Added the `scoped-store-shim` guard with its registry and barrel/alias/namespace/re-export resolution, per-subject baseline keys in the scan, `paths.ts`, and per-store totals in `update-baseline.ts`. Committed only this guard's baseline section (`--guard scoped-store-shim`: `[claude-options] apps/web/src/App.tsx: 1`). Wrote `docs/development/node-scopes.md` and the doc links. Tests: `scoped-store-shim.test.tsx` (9), `claudeOptionsStore.test.ts` (5). Web focused run (`src/lib/node-scope`, `src/stores`, `App.test.tsx`, `src/components/terminal`, `CreateEnvironmentFlowDialog.test.ts`): 1,304 pass across 72 files. `tests/unit/source-guards.test.ts`: 44 pass, and 1 fails (the repository ratchet, on the other guards' pre-existing findings only). Web typecheck clean; oxlint (including `apps/web/src` for `import/no-cycle`) and fmt clean on the touched files.
- 2026-11-07 (orchestrator, completeness check): noted that the per-store shim totals are all 0 now (`scoped-store-shim` baseline `{}`).
