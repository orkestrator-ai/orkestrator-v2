---
id: 3018
title: "Retire the command-scope store shim"
phase: 3
plan: "§7.2, §7.3 and §12 Phase 3"
status: done
depends_on: [3013, 4004]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] Move every test that seeds or reads a store through its statics to an explicit scope (`renderInNodeScope` / `renderInAppCommandScope`, `scope.store(def)`), store by store. *(Statics: `appCommandStore(def)` for suites on the app's command scope, in slices by store group. Renders: `renderInAppCommandScope`, `renderHookInAppCommandScope`, `InAppCommandScope`.)*
- [x] Make each converted store's hook the strict `useScopedStore(def, selector)` and remove its statics; remove `scopedStoreHook`'s fallback and `noteShimUse` once no store uses them. Keep [4004](4004-runtime-shim-guard.md)'s guard only if something still feeds it; otherwise delete it with a note. *(Deleted: nothing feeds it. See Notes.)*
- [x] Retire the `scoped-store-shim` source guard (or keep it as a guard that a static never comes back), and update `docs/development/node-scopes.md`. *(Retired; see Notes.)*

## Tests

- [x] The web suite and the root unit suites pass with no store statics left. *(Web 14,166 pass, 10 skip, 0 fail across 964 files. Root unit `--parallel=3`: every suite passes except four failures that are already on `HEAD` without this item's changes. They are listed in the Notes.)*
- [x] A test proves a hook used outside a provider throws in development and tests. *(`lib/node-scope/scoped-store.test.tsx`)*

## Done when

- [x] No per-node store exports command-scope statics, and no hook falls back to the command scope. *(A production build still has `useNodeScope()`'s safety net. It is shared by every scope reader, not only the store hooks, and the orchestrator asked to keep it. See Notes.)*

## Notes

- 2026-11-07 (orchestrator): created from 6004's open box. The report's §7.3 described the shim as a migration aid with a ratchet; this item completes the migration.
- **API (2026-11-07).**
  - `scopedStoreHook(def)` has moved to `lib/node-scope/scoped-store.ts` and is now strict. It returns `ScopedStoreHook<S>`, which has the call signatures `(): S` and `<U>(selector) => U` and a `def` property. It is `useScopedStore(def, selector ?? identity)` and has no statics. All 39 store modules import it from there.
  - `strictScopeChecks(env?)` is now exported from `providers.tsx`, so a test can pass `DEV: true`.
  - `useOptionalNodeScope` is kept for its two non-store readers, `SystemUsageIndicator` and `useHydrateOncePerEnvironment`, and its doc comment is updated.
  - Test support:
    - `appCommandStore(def)` in `apps/web/src/test/app-command-store.ts` returns `getWindowScope().commandScope().store(def)`, looked up at each call.
    - `renderHookInAppCommandScope(callback, { wrapper })` and `InAppCommandScope` (for `renderToStaticMarkup`) are in `test/render-in-node-scope.tsx`. `renderInAppCommandScope` now shares their wrapper.
  - `tests/source-guards/window-stores.ts` holds `WINDOW_STORES`, the 22 window stores (4004's `SHIM_GUARD_EXEMPT_STORES` moved here).
  - `repositoryModules` and `ReadModule` have moved from the deleted guard to `tests/source-guards/web-modules.ts`.
- **Decision: how the tests name their scope (2026-11-07).**
  - Options:
    - (a) Rewrite each suite onto its own `renderInNodeScope` scope.
    - (b) Seed and read the app's command scope's instance through a helper, and render under that scope (`renderInAppCommandScope`).
  - (a) changes what about 300 suites test: their `@/lib/backend` mocks are command-bound and would stop seeing calls.
  - (b) keeps every suite's meaning: the statics were the command scope's instance, and the provider-less fallback was the command scope. It also names the scope explicitly at every site.
  - Chosen: (b). About 6,800 static uses in 311 files were moved by an AST codemod (store by store, eight commits), and about 260 suites that rendered without a provider were moved by a second codemod.
  - Suites that already had their own scope (`renderInNodeScope`) are unchanged.
- **Decision: 4004's runtime guard (2026-11-07).** Deleted, with its tests, `useInTreeLeafMount` in `InTreeWorkspace`, the `VITE_ORKESTRATOR_SHIM_GUARD` probe and the `web.node-scope` `shim-under-leaf` log event. Nothing feeds it any more:
  - `noteShimUse` was called only by the statics and the provider-less fallback, and both are gone.
  - A hook under a leaf always finds the leaf's provider.
  - The log event is safe to drop because it was added on this same unreleased branch, so no released renderer sends it.
  - The multi-node e2e (`e2e/agent-testing/multi-node-window.spec.ts`, outside this item's file set) read the probe after every flow. `checkScopes` replaces it: no `node-workspace-error` render failure (a provider-less hook throws in its development renderer and lands in the node's error boundary), and the shown node's in-tree region is mounted. The evidence key is now `scopeChecks`. It typechecks; it was not run live.
- **Decision: the `scoped-store-shim` source guard (2026-11-07).**
  - Options:
    - (a) Keep it as "a static never comes back".
    - (b) Retire it.
  - Without statics on the hook type, a static call or a hook passed as a `StoreApi` no longer typechecks. (a) would count something the compiler already refuses.
  - Chosen: (b). The guard, its `SHIMMED_STORES` registry and its baseline key are removed.
  - What the registry also protected is kept as a repository test in `tests/unit/source-guards.test.ts` ("renderer store registry"): every module in `apps/web/src/stores` is either a scoped store exporting its hook through `scopedStoreHook` from `scoped-store.ts`, or a listed window store.
- **Deviation: "no hook falls back to the command scope" (2026-11-07).** In a production build, `useNodeScope()` outside a provider still returns the app's command scope. This is the same safety net every scope reader has had since 2001. The orchestrator's prompt asked to keep it ("only tests/dev throw").
  - The store hooks have no fallback of their own.
  - Development and tests throw (`useNodeScope() needs a NodeScopeProvider`).
  - Every app tree renders under `CommandNodeScopeProvider` or a node's `NodeScopeProvider`.
- **Found and fixed: a production structural use of the statics.** `ClaudeTmuxChatTab.parts.tsx` passed the hook `useClaudeTmuxStore` itself to `useNativeComposeDraftPersistence` as its `{ getState, subscribe }` store, and passed no scope. A tmux tab on a leaf therefore persisted and restored its draft against the command scope's store and the command node.
  - The guard could not see this, because it counted only member calls.
  - It now passes `tmuxScope.store(claudeTmuxStore)` and `tmuxScope`. On the command node the behaviour is unchanged.
- **Test gotcha (recorded in node-scopes.md).** `AppShell.test.tsx` mocks `@/stores` with a `useUIStore` wrapper around the real hook. Referencing the imported real hook inside the mock factory recursed forever, because the mock rebinds the import and the wrapper ended up calling itself. The suite hung. The fix captures the hook in a constant before `mock.module`, as the suite did before.
- **Pre-existing root unit failures (2026-11-07).** These fail identically on a clean checkout of `a34b4b9bb` without this item's changes:
  - `source-guards.test.ts` "no file has more findings": known backend, bridge and e2e baseline findings; nothing from `lib-backend-command-default` or `workspace-command-bound-call`.
  - `test-suite-ownership.test.ts`, two tests: `e2e/agent-testing/session-history-environment.test.ts` has no owner, plus the cross-package import test.
  - `dom-absence-scan.test.ts`: the same files on `HEAD`, minus the deleted `InTreeWorkspace.shim-guard.test.tsx`.
  - `tests/unit/lib/terminal-paste.test.ts` has a TS2741 error in `bun check -p tests/tsconfig.json` that is not this item's.
  - Aggregate suite (`mise run test`) left to review preparation.
- **Where Effect is used, and where not.** Not used. This item deletes a synchronous hook shim and its observer, and moves tests. No lifetime, failure or retry is added.
- **Outside the file set (minimal).**
  - Production callers of `useShimNodeScope`/`useScopedStoreApi` (about 80 files) changed one import and the call.
  - `components/federation/InTreeWorkspace.tsx`: two lines removed.
  - `components/claude/ClaudeTmuxChatTab.parts.tsx`: the fix above.
  - `lib/node-scope/providers.tsx`: `strictScopeChecks` exported, and a doc comment.
  - `packages/protocol/src/log-vocabulary/web-sync.ts`: one event removed.
  - `e2e/agent-testing/multi-node-window{,-support}.ts`.
  - `tests/source-guards/{guard,scan,update-baseline,lib-backend-command-default,workspace-command-bound-call,web-modules}.ts`.
  - Docs: `AGENTS.md`, `docs/README.md`, `linting.md`, `testing-guide.md`, `renderer-security.md`.
- **For the orchestrator.** The report's §7.3 still describes the shim and its ratchet, and §7.x and §12 mention the runtime guard's `shim-under-leaf` event. They should say that 3018 retired both. The 4004 item describes a guard that no longer exists. Its Notes could link here.

## Work log

- 2026-11-07 (claude-worker):
  - Commits:
    - Statics, store by store: `81879e890`, `623f3a0e0`, `c27d438e8`, `92cafdf8d`, `3346cac8d`, `778cc2262`.
    - Provider-less renders: `73f76142e`. This was checked on a clean checkout of `HEAD` with the old shim in place: web suite pass, unit files 1,565 pass.
    - Strict hooks, the shim and both guards retired: `dfec5911a`.
    - Docs, the dev-mode test and these notes: the commit after it.
  - Tests:
    - Web suite (`bun --cwd=apps/web test src --parallel=3`): pass, run after each slice and after the shim removal.
    - Root unit (`bun test tests/unit --parallel=3`): only the four failures that are already on `HEAD` (Notes).
    - `scoped-store.test.tsx`: 6 pass, covering the strict check in development, tests and production; the throw outside a provider; the production fallback; and the hook having no statics.
    - Protocol log vocabulary: pass.
  - Typecheck: web, protocol and e2e/agent-testing are clean; tests has only the TS2741 above.
  - fmt and oxlint clean on touched files.
