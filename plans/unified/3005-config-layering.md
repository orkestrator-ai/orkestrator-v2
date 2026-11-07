---
id: 3005
title: "configStore per node with effectiveConfig(scope) layering"
phase: 3
plan: "§9 Settings layering and §12 Phase 3.2"
status: done
depends_on: [3001, 3002]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3005 · configStore per node with effectiveConfig(scope) layering

- **Report:** [§9](../../docs/reports/unified-federation.md#9-cross-node-features) (Settings layering)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md)
- **Parallel with:** [3003](3003-stores-batch-a-leaf-light.md), [3004](3004-project-and-environment-stores.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

Inherited settings are computed from two explicit scopes, not from "is this renderer a realm".

## Current state (verified 2026-11-07)

- `configStore`: 93 LOC, 15/10 imperative sites, 28 direct importers, 57 references, 66 test files. It has no store dependencies.
- `apps/web/src/lib/portal/command-node-config.ts` (222 LOC): `settingsOnCommandNode()` is `workspaceTarget() !== null`. It calls the portal helper `isUnknownBackendCommand` (fixed in [0007](0007-unknown-command-helper.md)).
- `hooks/useAgentModelFavorites.ts` writes favourites with `update_global_config` plus `preserveInheritedSettings`. An upgraded leaf answers an unchanged echo with its current settings (`isGlobalConfigEcho`, counter `workspace-grant.config-echo`; todo 5740 task 2).

## Work

- [x] Convert `configStore` to a scoped store.
- [x] `effectiveConfig(scope) = layer(commandScope.config, scope.config)`, with the same layering rules as `command-node-config.ts`.
- [x] Split saves take both scopes explicitly: the inherited parts go to the command scope, and the machine parts go to the node scope.
- [x] `useAgentModelFavorites` keeps the echo-compatible request shape for leaves that need it. Check the register row before changing it.

## Tests

- [x] Layering: a command-node value is inherited, a leaf override wins, and saving each part reaches the right scope's client.
- [x] `command-node-config` tests ported to explicit scopes.

## Done when

- [x] No code reads `workspaceTarget()` to decide config layering.

## Notes

- **API (2026-11-07).**
  - `apps/web/src/lib/portal/command-node-config.ts` (the layering rules, now over explicit targets):
    - `ConfigTargets { commandNode: BackendClient; node: BackendClient | null }` (`null`: the command node itself, no split).
    - `layerConfig(commandNode, node) → AppConfig` (was the private `workspaceConfig`; unchanged rules: drop the node's inherited keys, lay the command node's `pickInheritedGlobalSettings` over, coerce the default agent to one the node has enabled).
    - `runConfigCommandLayers(targets, command, args?) → { config, commandNode, node }`, `runConfigCommand(targets, command, args?) → AppConfig` (effective), `runCommandNodeSetting<T>(targets, command, args?)`. The split rules (patch by key, whole-object update with the coerced-default-agent echo guard and `preserveInheritedSettings` on the machine, other commands on the machine with the command node's config read beside them, `patchGlobalOnNode`'s older-node fallback) are unchanged.
    - Settings parents: `SettingsParent { scope: NodeScope | null; client; onConfigChanged }`, `settingsParent(scope)`, `bindSettingsParent(scope, parent | null)`, `configTargetsFor(scope)`, `configTargetsForScopes(scope, commandScope)`.
    - The command-bound shim the `@/lib/backend` config functions use is unchanged in signature: `invokeGlobalConfigCommand(command, args?, machine?)`, `invokeRepositoryConfigCommand`, `invokeCommandNodeSetting`. `machine === undefined` now means `configTargetsFor(appCommandScope())`. `settingsOnCommandNode()` is deleted (no callers left).
  - `apps/web/src/stores/configStore.ts`: `configStore = defineScopedStore<ConfigState>("config", …)`, `useConfigStore = scopedStoreHook(configStore)` (barrel exports both). New state: `layers: { node, inherited } | null`; new actions `setLayers(node, inherited | null)`, `setInheritedConfig(inherited | null)`. `effectiveConfig(scope, commandScope = settingsParent(scope)?.scope)`. `runScopedConfigCommand({ scope, commandScope }, command, args?)`: the split save for two named scopes; it writes each scope's store with what its node answered and resolves with the effective config.
  - `lib/store-resource-sync.ts`: the `config` registration is now `every-scope` and reads `context.scope.store(configStore)`; the app command scope keeps `getConfig` (suites mock it), any other scope reads its own node (`runConfigCommand`), and a parent with no scope (the realm portal) is followed through `SettingsParent.onConfigChanged`. Agent mail is still a command-scope store, so only a command scope clears it. `agent-mail`'s registration reads `context.scope.store(configStore)`.
- **Decision: where the second node comes from (2026-11-07).** Options:
  - (a) Keep `settingsOnCommandNode()` and only rename it. That is still "am I a realm".
  - (b) Open the realm's command node as a real `NodeScope` over `window.orkestratorPortal`. `WindowScope` allows one command scope, a second scope would start every-scope services (resource sync, store bindings) for the command node inside every realm, duplicating the host window's, and Phase 6 deletes realms anyway.
  - (c) An explicit settings parent per scope (chosen). An in-tree leaf's parent is its window's command scope (or a binding, for test windows and 4001's opener); the command scope of the app window has none, except in a realm document, whose parent is the page's portal channel (`window.orkestratorPortal`, which the desktop preload and the browser gateway expose only to realm documents). All layering code takes the two targets it is handed; the portal channel enters in exactly one function (`pagePortalParent`), which 6002/6003 delete with realms.
- **Decision: what the store holds (2026-11-07).** Options: (a) each scope's store holds its node's raw config and readers call `effectiveConfig`, which would make every one of the ~57 hook readers wrong under a leaf provider; (b) the store's `config` is always the effective view, and a layered scope keeps both layers (chosen). Under a parent scope the leaf store subscribes to the parent's store (stopped by `scope.onDispose("config.inherited")`, invariant 15) and re-lays. With `layers === null` every action is exactly the old code, so the many suites that `useConfigStore.setState({ config })` are unaffected. `setConfig(x)` on a layered scope treats `x` as the node layer; an effective config is fine there because `layerConfig` takes only the node's machine keys.
- **Decision: config handlers stay in `store-resource-sync.ts` (2026-11-07).** The recipe moves a registration into the store's module, but `configStore` importing `defineStoreResourceHandlers` while `STORE_RESOURCE_HANDLERS` imports the registration back is an `import/no-cycle` error, and it would pull the whole sync graph into a module 57 files import. The registration is rewritten in place to `every-scope` instead.
- **`useAgentModelFavorites` and the register row.** The row (`docs/architecture/version-compatibility.md`, "Realms from before `patch_global_config`…") is about command nodes through v2.35.1-beta whose realms echo the leaf's settings with `update_global_config` + `preserveInheritedSettings`; the backend answers that echo (`isGlobalConfigEcho`). This client already sends `patch_global_config`, so nothing in the row changes. The request shapes are kept exactly: favourites are an inherited key, so under a parent only the command node gets `{ patch: { favoriteModels } }` and the machine gets no write; a node without the patch command gets `patchGlobalOnNode`'s read-merge-write, with `preserveInheritedSettings: true` only on the machine side. The write queue (`tail`, `revision`, `pending`, `committed`) moved from module `let`s into a scoped slot (`model-favorite-writes`), so two nodes' writes are ordered separately. The app command scope keeps the `patchGlobalConfig` named export, because `AgentNativeTab.test.tsx` spies on it.
- **`getGlobalConfig` (factory member, no callers).** It now always returns the client's node's own `get_global_config`; before, in a realm it returned the layered global. Nothing calls it (checked: only the factory and the shim reference it).
- **Shim uses.** `config`: **6** in 6 files (2026-11-07). Converted: `settings-config.tsx`, `FeaturesView.tsx` (a `scope` parameter on `getPreferredEnvironmentType`), `useAgentModelFavorites.ts` (5), `store-resource-sync.ts` (2), all through `useScopesWithCommandFallback().scope` (the shim's own fallback, as 3003/3004 do) or the registration's `context.scope`. Left: `ClaudeTmuxChatTab.tsx`, `DesignWorkspaceDialog.tsx` and `AgentNativeTab.tsx` carry other agents' uncommitted store conversions in this wave (3003, 3004), and the config site sits next to theirs, so converting it would have mixed hunks; the next item touching them retires them mechanically (`scope.store(configStore).getState().config` with the scope those files now take). `notification-sounds.ts`, `useNotificationSoundService.ts` (`soundSettings`) and `terminal-links.ts` are window-level or plain code with no scope yet (attention sounds are one window service, report §9).
- **Guards.** `SHIMMED_STORES` gains `config`. `direct-transport-import` loses `lib/portal/command-node-config.ts` (it no longer imports `@/lib/native/backend`). `lib-backend-command-default`: `useAgentModelFavorites.ts` now defines a slot, and uses no command-bound const (`patchGlobalConfig` is a module function), so it adds nothing. The baseline was regenerated with `--guard scoped-store-shim --guard lib-backend-command-default --guard direct-transport-import`; it reflects other agents' uncommitted files at that moment, as the brief allows.
- **Docs.** `docs/architecture/command-nodes.md` ("Settings", "In the client") describes the targets, settings parents and per-scope store.
- **Where Effect is used, and where not.** Not used. Layering is a pure function over two configs, the targets are two `BackendClient`s, and the store is synchronous zustand that React reads directly. The one lifetime (the leaf store's subscription to its parent) is a finalizer on the scope's Effect-backed `Lifetime` through `scope.onDispose`. Typed failures stay as they were (`incompatibility(error, …)` for the older-node fallback).
- **For the report.** §9's "Settings layering" row can read: `ConfigTargets` + `settingsParent(scope)`; `effectiveConfig(scope)`; split saves `runScopedConfigCommand({ scope, commandScope })`; the realm portal is the one non-scope parent until Phase 6.
- **Tests.** Aggregate suite (`mise run test`) left to review preparation.

## Work log

- 2026-11-07 (claude-worker): rewrote `lib/portal/command-node-config.ts` over explicit `ConfigTargets` with settings parents; converted `configStore` to a scoped store with layers, `effectiveConfig` and `runScopedConfigCommand`; moved the `config` resource registration to `every-scope`; converted the imperative sites in `settings-config.tsx`, `FeaturesView.tsx`, `useAgentModelFavorites.ts` (queue into a scoped slot) and `store-resource-sync.ts`; `getGlobalConfig` no longer asks about realms; `SHIMMED_STORES` entry and baseline; `command-nodes.md`. Tests: `command-node-config.test.ts` 29 (realm tests now set only the portal channel, plus 9 explicit-scope tests), `configStore.test.ts` 13 (7 new: per-scope state, inheritance, following the parent until dispose, optimistic layered updates, split save per scope, a leaf scope's own sync, the statics), `useAgentModelFavorites.test.tsx` 19 (2 new under a leaf scope), `agent-accounts.test.ts` 14, `store-resource-sync.test.ts` 83. Focused web run (`components/settings`, `hooks`, `stores`, `lib/portal`, `lib/backend`, `backend.test.ts`, `store-resource-sync`, `scope-services`, `components/kanban`, `components/design`, `components/environments`, `App.test.tsx`): 3,385 pass, 0 fail. `tests/unit/source-guards.test.ts`: 97 pass, 3 fail (the repository ratchet on pre-existing test-guard findings, and 3007's `project-pull-requests` barrel check), none for `config`. Web typecheck: no errors in touched files (other agents' in-progress files have errors). oxlint over `apps/web/src`: no `import/no-cycle`, no errors in touched files.

