---
id: 4004
title: "Runtime guard: no command-scope shim calls under a leaf"
phase: 4
plan: "§7.3 guard 2 and §12 Phase 4.5"
status: in-progress
depends_on: [4001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] While any in-tree leaf scope is mounted, `noteShimUse(storeName)` throws in `development` and `test` when the store is in the workspace-subtree set from [3013](3013-pane-layout-store.md). In production it records a content-free `node-scope.shim-under-leaf` log event with the store name only.
- [x] Stores outside the workspace subtree (window-level or command-only) are exempt. List them explicitly.
- [x] Add the guard to the multi-node e2e in [4006](4006-multi-node-qualification.md): the flag and probe the e2e turns on (`VITE_ORKESTRATOR_SHIM_GUARD`, `window.orkestratorShimGuard`), and a box in 4006's Work list saying how to use them.
- [x] The multi-node e2e runs with the guard on: `e2e/agent-testing/multi-node-window.spec.ts` ([4006](4006-multi-node-qualification.md)) starts the renderer with `VITE_ORKESTRATOR_SHIM_GUARD=throw` and asserts after every flow that `orkestratorShimGuard.uses()` is `[]` and `mountedLeaves()` names the shown in-tree leaf.

## Tests

- [x] With a leaf mounted, a shim call on a workspace store throws in tests; an exempt store does not; with no leaf mounted, nothing throws.

## Done when

- [x] The guard is on: it is `noteShimUse`'s default observer, so every web test and every renderer runs with it, and the in-tree workspace's suites pass with it (`InTreeWorkspace.shim-guard.test.tsx` mounts a real in-tree workspace under it).
- [x] The multi-node e2e's guard checks pass: 0 shim uses in every flow, browser (33 checks) and desktop (33 checks), six leaves mounted at once ([4006](4006-multi-node-qualification.md) Notes).
- [ ] The full suite and the whole multi-node e2e pass with it. Open: the aggregate suite is left to review preparation; the desktop e2e has two failures unrelated to the guard (an in-tree leaf's preview resolves through the command node's gateway; terminal input after a grant lapse), see 4006.

## Notes

- **API (2026-11-07).** `apps/web/src/lib/node-scope/shim-under-leaf-guard.ts`:
  - `WORKSPACE_SUBTREE_STORES` (the 39 store names from 3013's Notes, `as const`), `SHIM_GUARD_EXEMPT_STORES: readonly { store, module, kind: "window" | "command-only" }[]`, `isGuardedShimStore(store)`.
  - `shimUnderLeafGuard({ store, via })`: `noteShimUse`'s default observer. Returns at once with no leaf mounted or for a store outside `WORKSPACE_SUBTREE_STORES`; otherwise counts the use, then throws `ShimUnderLeafError` (`store`, `via`; the message names the store, the kind and the remedy, never a value) in `throw` mode, or logs `web.node-scope` `shim-under-leaf` `{ store, via }` at `warn` on the first use per store and kind in `count` mode.
  - Mount marks: `markInTreeLeafMounted(nodeId) → release` (counted per node, release idempotent), `useInTreeLeafMount(nodeId)` (a layout effect; `InTreeWorkspace` calls it), `inTreeLeafMounted()`, `mountedInTreeLeaves()`.
  - Counts: `shimUnderLeafCounts() → { store, via, count }[]`, kept in both modes, bounded by the guarded stores times the five kinds.
  - Mode: `ShimGuardMode = "throw" | "count"`; `defaultShimGuardMode(env?)`: `VITE_ORKESTRATOR_SHIM_GUARD` (`SHIM_GUARD_ENV`) when it is `throw` or `count`, else `throw` when `DEV`, `MODE=test` or `NODE_ENV=test` (the strict check `providers.tsx` uses), else `count`.
  - e2e probe: with the flag set, the module installs `window.orkestratorShimGuard: ShimGuardProbe` (`mode`, `mountedLeaves()`, `uses()`), read-only; `installShimGuardProbe(target)` for tests. Without the flag no global is added.
  - Tests: `configureShimUnderLeafGuard({ mode?, reset? }) → restore`, `resetShimUnderLeafGuardForTests()`.
  - `scoped-store-shim.ts` (additive): the observer slot starts as `shimUnderLeafGuard`; `setShimUseObserver` still replaces it (and restores it). Doc comments updated.
  - `packages/protocol/src/log-vocabulary/web-sync.ts`: `shim-under-leaf` added to `web.node-scope` (the item's `node-scope.shim-under-leaf` is that area and event).
- **Decision: where the guard is installed (2026-11-07).** Options: (a) install it with `setShimUseObserver` at renderer startup and again in the test preload; (b) make it the shim's default observer. (a) needs edits to `renderer-entry.tsx`/`app-startup.ts` and the shared test setup, and a renderer or test that loads the shim another way runs unguarded. (b) has no bootstrap edit, and the guard is on wherever the shim is loaded, which is what "the guard is on" asks; the cost is one import from the shim to the guard module (the guard imports nothing from the shim, so there is no cycle). Chosen: (b). 3001's own shim tests that observe uses replace it through `setShimUseObserver`, as before.
- **Decision: what "a leaf is mounted" means (2026-11-07).** Options: (a) any leaf scope open in the app's window scope (`nodeScopes`); (b) `inTreeScopeHolds` from `in-tree-scopes.ts`; (c) an explicit mark that `InTreeWorkspace` sets while it is mounted. (a) also counts a scope kept for the 60 s grace after unmount, the dev scope-proof harness and any warm scope 4002 adds for nodes that render nothing, where a shim use is the command node's own. (b) also counts the grace period, and 4002 replaces the holds with tiers. Chosen: (c), one hook call in `InTreeWorkspace` (outside this item's file set; three added lines). The mark is set in a layout effect when the region mounts, before its scope opens, so it covers every render of the leaf's subtree. **Known gap:** React runs a deleted parent's effect cleanups before its children's, so a shim use inside an unmount cleanup of a component in the leaf's subtree is not caught.
- **Decision: what production records (2026-11-07).** The orchestrator's prompt said "a content-free counter into the renderer metric/error ring". There is no renderer metric ring; the error ring (`renderer-error-ring.ts`) keeps `{ errorClass, boundary, route, fingerprint, count }`, and the backend refuses a whole upload batch with any value outside its closed lists (`parseRendererErrorBatch`). Options: (a) a new boundary value: an older backend would refuse every batch carrying it, losing real error counts with it, and it changes a wire contract for a migration aid; (b) an existing boundary with a fingerprint from the store name: misreports a caught render error and cannot name the store; (c) the item's log event plus an in-memory counter. Chosen: (c). The log line carries the store name and the kind (`getState`, `setState`, `subscribe`, `getInitialState`, `hook-without-provider`): both static identifiers, no node id, path or value. **Deviation:** the item says "the store name only"; the kind is added because it tells a static from a provider-less hook (3001's two-argument `noteShimUse`). It is written once per store and kind per page load, so a shim use on a render path cannot flood the log; the counts keep counting and are readable through `shimUnderLeafCounts()` and the probe.
- **Exempt stores (2026-11-07).** 3013 found that a workspace's import closure reaches all 39 converted stores, so none of them is exempt. `SHIM_GUARD_EXEMPT_STORES` lists the 24 window stores, one instance per window, never per node: active-coordinator-conversation, app-dialog, artifact-live-host, bug-report, conversation-scroll-target, error-dialog, files-panel-chrome, flow-graph-view, global-settings, in-tree-nodes, machine-bulk-update, machine-view, merge-pr-request, message-part-expansion, native-notice-dismissal, project-copy, realm-shell, remote-workspace, rich-content-view, sidebar-action, static-html-frame-slots, terminal-portal, ui-chrome, window-selection. No store is command-only yet. None of these has a shim, so today none reaches `noteShimUse`; the list makes the classification explicit, and a test fails when a module in `stores/` without `defineScopedStore` is missing from it, when an entry names a missing module, or when a `SHIMMED_STORES` entry is in neither list. A name in neither list (a test's own def) does not throw.
- **Where Effect is used, and where not.** Not used. The guard is a synchronous observer on the shim's hot path (one map-size check when no leaf is mounted), and a thrown `Error` subclass is what React's error overlay, `NodeErrorBoundary` and the test runner show; nothing catches it in an Effect, so `Data.TaggedError` would add nothing. The mount marks are a counted map, not a lifetime: the leaf's scope lifetime (Effect-backed) is `in-tree-scopes.ts`'s and outlives the mount by the grace period.
- **Outside the file set (minimal).** `components/federation/InTreeWorkspace.tsx` (import plus `useInTreeLeafMount(nodeId)`), `packages/protocol/src/log-vocabulary/web-sync.ts` (one event), `docs/development/node-scopes.md` (the pieces table and the runtime-guard paragraph), `plans/unified/4006-multi-node-qualification.md` (one Work box: run the e2e with the guard on).
- **For 4006.** Start the renderer with `VITE_ORKESTRATOR_SHIM_GUARD=throw` (it is a Vite variable, so it goes in the environment of the Vite dev server (`mise run dev:test` launches it), or of `vite build` for a production renderer) and assert `window.orkestratorShimGuard.uses()` is empty after each flow; `mountedLeaves()` names the in-tree nodes. A throw under the flag reaches `NodeErrorBoundary` (`workspace.render-failed`) when it happens in render, and the probe lists it in every case.
- Aggregate suite (`mise run test`) left to review preparation.
- **Test isolation (for the orchestrator, pre-existing).** In one sequential process, `InTreeWorkspace.test.tsx` (4001) and the new `InTreeWorkspace.shim-guard.test.tsx` both fail after `FederationProvider.test.tsx` or `AgentsMdApprovalDialog.test.tsx` (the in-tree region renders nothing; `FederationProvider.test.tsx` leaves `portalStore` state and its `invoke` mock behind). Checked with the guard disabled: the same failure, so it is not the guard's. With `--parallel` (files in separate processes) both pass.

## Work log

- 2026-11-07 (claude-worker): added `lib/node-scope/shim-under-leaf-guard.ts` (workspace and exempt store lists, mount marks and `useInTreeLeafMount`, `shimUnderLeafGuard` with `throw`/`count` modes, counts, the `shim-under-leaf` log line, `VITE_ORKESTRATOR_SHIM_GUARD` and the `window.orkestratorShimGuard` probe); made it the shim's default observer (`scoped-store-shim.ts`); `InTreeWorkspace` marks its leaf mounted; `shim-under-leaf` in the `web.node-scope` vocabulary; `docs/development/node-scopes.md` updated; a Work box in 4006 for the e2e. Tests: `shim-under-leaf-guard.test.tsx` 12 (every kind of use throws with a leaf mounted and is counted first; the error carries no value; exempt and unlisted stores do not throw; a scope's own instance is never a use; with no leaf nothing throws; mount marks follow the component and count per node; production counts and logs once per store and kind, content free; mode resolution; the probe; a test observer replaces and restores the guard; every `SHIMMED_STORES` store is classified, the lists are disjoint, and every window store module is listed) and `InTreeWorkspace.shim-guard.test.tsx` 1 (a real in-tree workspace mounts the mark, renders and takes the window's request with no shim use, a misrouted static throws, unmount clears it). Whole web suite with the guard on (`bun --cwd=apps/web test src --parallel=4`): 14,087 pass, 10 skip, 32 fail; none of the failures mounts an in-tree leaf or mentions the guard (config layering, accounts and MCP domain clients, sign-in, Docker settings: other agents' in-flight areas), and with no leaf mounted the guard returns before doing anything. `components/federation` and `lib/federation`: all pass except the pre-existing ordering failure above. Protocol `log-vocabulary` 18 pass. `tests/unit/source-guards.test.ts`: only the known baseline findings in other files. Web typecheck: one error, in another agent's `lib/federation/window-attention.ts`; protocol typecheck clean. fmt and oxlint clean on touched files.
- 2026-11-07 (claude-worker, 4006): the multi-node e2e (`multi-node-window.spec.ts`, commits `d737fa679`, `72ae46d49`) runs with `VITE_ORKESTRATOR_SHIM_GUARD=throw` and reads the probe after every flow: `uses()` `[]` in all 33 checks on the browser and all 33 on the desktop (six in-tree leaves, `mountedLeaves()` 1 → 6), live against `uf-4006-cmd`/`uf-4006-leaf` at `72ae46d49`. E2e box ticked; the "pass with it" box split (guard checks pass; the whole desktop e2e and the aggregate suite still open).
