---
id: 3012
title: "Convert design, web annotation, GitHub, PR, change, file and preview stores"
phase: 3
plan: "§12 Phase 3.5"
status: done
depends_on: [3004, 3016]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3012 · Convert design, web annotation, GitHub, PR, change, file and preview stores

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3004](3004-project-and-environment-stores.md), [3016](3016-rich-content-and-caches.md) (capability caches per scope)
- **Parallel with:** [3011](3011-workflow-stores-a.md), [3009](3009-agent-and-transcript-stores.md)
- **Size:** L
- **Track:** S (scopes)

## Stores (verified 2026-11-07)

- `designStore` (150 LOC, 5 sites), with `lib/design-client.ts` (372 LOC; capability `Map` at :109).
- `webAnnotationStore` (433 LOC, 20/20), `webAnnotationPreferencesStore` (57 LOC, persisted).
  - `lib/web-annotations/sync.ts` (737 LOC, 14 sites).
  - `lib/web-annotations/local-drafts.ts:13` uses the un-namespaced key `orkestrator.web-annotations.local-drafts.v1`.
- `githubIssuesStore` (568), `pullRequestsStore` (558, 10/8).
- `changeProjectionStore` (149, 8/8), with `lib/changes/subscriptions.ts` (291 LOC, 10 singletons) and `lib/backend/changes.ts:129` (capability `let`).
- `fileDirtyStore` (165, 6/1), with `file-draft-persistence.ts` (229 LOC, 4 singletons) and `file-subtree-loads.ts`.
- `previewServiceStore` (283, 14/10).

## Work

- [x] Convert each store. Turn the sync engines and subscriptions into scoped services.
- [x] Namespace the local-drafts key by node ([3015](3015-persistence-keys-per-node.md)), migrating the existing un-namespaced data to the command node.
- [x] The preview service store uses the node client's preview URLs ([2004](2004-browser-node-clients-registry.md), [2009](2009-desktop-previews-and-gateway-snapshot.md)).

## Done when

- [x] All stores in this item are converted, with shim counts at target, and the web annotation and design suites pass. (Aggregate suite left to review preparation.)

## Notes

- **API (2026-11-07).** Every store is `defineScopedStore<S>(name, …)` plus `useXStore = scopedStoreHook(def)`, its state interface exported, registered in `SHIMMED_STORES` and exported (def beside hook) from `@/stores`:
  - `designStore` (`"design"`), `webAnnotationStore` (`"web-annotation"`; disposing the scope revokes its object URLs through `scope.onDispose`), `webAnnotationPreferencesStore` (`"web-annotation-preferences"`; persisted under `nodeStorageKey("web-annotation-preferences", scope)`, the command node's key unchanged), `githubIssuesStore` (`"github-issues"`), `pullRequestsStore` (`"pull-requests"`), `changeProjectionStore` (`"change-projection"`), `fileDirtyStore` (`"file-dirty"`), `previewServiceStore` (`"preview-service"`).
  - Backend calls inside the creators go through `backendApiForScope(scope, createXApi, backend)`: `createConfigIntegrationsApi` (issues), `createGithubPullRequestsApi` (PRs), `createPreviewsApi` (previews). The per-request sequence maps of the issues and PR stores (module `Map`s before) are per instance now, so one node's mutation never fences another node's reads.
  - `previewServiceStore` gains `resolvePreviewUrl(url)`: the scope client's `resolvePreviewUrl` when it has one (a leaf client from 2004 relays it), otherwise `resolveGatewayBrowserPreviewUrl`. `resolveBrowserAddress(value, resolvePreviewUrl = resolveGatewayBrowserPreviewUrl)` takes it; `BrowserTab` and `ServiceBrowserTab` (compatibility frames) pass the store's.
  - Helpers that took no node gained an optional trailing `scope`, the app's command scope when omitted: `getWebAnnotationCache(environmentId, scope?)`, `rememberedDestinationTabId(environmentId, scope?)`, `ensurePreviewServiceSync(scope?)`, `resetPreviewServiceSyncForTests(scope?)`, `startPullRequestDetailPolling(ref, scope?)`, `startPullRequestListPolling(projectId, filter, query?, scope?)`, `environmentBrowserTarget(env, legacyUrl, scope?)`, `linkBrowserTarget(env, url, origin?, scope?)`, `confirmLegacyUrlServiceMatch(url, environmentId, offered, scope?)`, `ExternalLinkRequest.scope?`.
- **Engines and subscriptions, per scope (2026-11-07).** Each is one `defineScopedSlot` whose `scope.onDispose` stops it (invariant 15); every export takes an optional trailing `scope`:
  - `lib/web-annotations/sync.ts` (`"web-annotation-sync"`): the engines by environment, the migration progress, the scope's store and its commands; listeners on `scope.client`; dispose stops every engine. `acquireWebAnnotationSync(id, options, scope?)`, `registerWebAnnotationList(id, query, scope?)`, `registerWebAnnotationThread(id, annotationId, scope?)`, `refreshWebAnnotations(id, request?, scope?)`, `refreshAllWebAnnotationCapabilities(scope?)`, `resetWebAnnotationSyncForTests(scope?)`.
  - `lib/web-annotations/assets.ts` (`"web-annotation-asset-reads"`): the reads in flight; `loadWebAnnotationAsset`, `retryWebAnnotationAsset`, `loadWebAnnotationCapture`, `resetWebAnnotationAssetsForTests` take `scope?`.
  - `lib/web-annotations/client.ts` (7004's file, additive): `webAnnotationCommand(command, args, machine?, scope?)` sends to a non-command scope through that scope's own domain client (`"web-annotations-domain"` slot); `fetchWebAnnotationCapabilities(environmentId?, scope?)`.
  - `lib/changes/subscriptions.ts` (`"change-subscriptions"`): interest, read queue, connection epoch, tool batches; the authoritative listener is the mocked `listenAuthoritative` on the app's command scope and `listenAuthoritativeWith` over `scope.client.listenRaw` elsewhere, and is stopped on dispose. `subscribeChangeResource(key, scope?)`, `requestChangeRead(key, join?, scope?)`, `subscribeToolPresentation(tool, callId, scope?)`, `requestToolPresentation(tool, callId, force?, scope?)`, `resetChangeSubscriptionsForTests(scope?)`. The change-tracking capability cache in `lib/backend/changes.ts` was already per scope (3016).
  - `lib/file-draft-persistence.ts` (`"file-draft-writes"`): write chains and revision states; every export takes `scope?`. `file-subtree-loads.ts` was already per scope (3007).
  - `stores/previewServiceStore.ts` (`"preview-service-sync"`): the change and reconnect listeners on `scope.client`.
  - `components/design/design-controller.ts` (`"design-controllers"`): controllers and the eviction timer; dispose disposes every controller. `DesignCanvasController(scope, backend, environmentId, canvasId)` holds the scope's store and `designApiFor(scope)`, listens on `scope.client`, schedules on `readCoordinatorFor(scope)` and reads capabilities with `getCapabilities(backend, scope)`. `designController(environmentId, canvasId, scope?)`, `evictInactive(scope?)`, `resetDesignControllers(scope?)`; `useDesignCanvas` reads the nearest scope. The backend key is the gateway on the app's command scope (unchanged) and the node id elsewhere.
  - `lib/design-client.ts` (7004's file, additive): `designApi` is now `createDesignApi()` over 7004's `v2(def, args, scope)`; `designApiFor(scope)` (a `"design-v2-api"` slot), `DesignV2Api`, `designAction(environmentId, action, input?, scope?)`.
- **Decision: slots, not `defineScopedService` (2026-11-07).** Options: (a) a `defineScopedService` per engine started with the scope; (b) a scoped slot started on first use. These engines start only when a view asks (an environment observed, a resource subscribed, a canvas acquired) and stop when the last view releases; a service would run for every warm scope whether or not anything shows it (4002 starts `WARM_SCOPE_SERVICES` for warm scopes). Chosen (b): per scope, refuses a disposed scope, and stopped by `scope.onDispose`, the same lifetime a service has.
- **Decision: the scope imperative sites use (2026-11-07).** `useShimNodeScope(def.name)` / `useScopedStoreApi(def)`, as 3003/3004/3007 do: about forty suites render these readers with plain `render`. `useWebAnnotationScope()` (`hooks/useWebAnnotations.ts`) is that for the annotation views. Under `renderInNodeScope` they read the rendered scope.
- **Decision: file drafts on another node skip the desktop handoff (2026-11-07).** `desktop_file_draft_write` makes main write to the window's command node, so only a `role: "command"` scope hands off; another node's drafts go through its own client (`save_file_draft`/`delete_file_draft`).
- **Shim counts (`scoped-store-shim`, 2026-11-07): 0 for every store of this item** (`design`, `web-annotation`, `web-annotation-preferences`, `github-issues`, `pull-requests`, `change-projection`, `file-dirty`, `preview-service`); every static use outside test files moved to a named scope. `lib-backend-command-default`: 0 for every module of this item. Test-support modules (`pull-request-test-fixtures.ts`, `change-projection-test-fixture.ts`) keep their statics (not counted). The baseline was regenerated with `--guard scoped-store-shim --guard lib-backend-command-default`; it reflects other agents' uncommitted files at that moment, as the brief allows.
- **3005's config site.** `DesignWorkspaceDialog.tsx`: `designInitialPromptOptions` takes the config, read from `useScopedStoreApi(configStore)` (`config` 1 fewer).
- **Local drafts.** 3015 namespaced the key and moved the v1 copy to the command node. `useAnnotationDraft` and `AnnotationEditor` now pass the panel's scope (`useWebAnnotationScope()`) as the storage node.
- **Open, deliberately (2026-11-07).** (1) The annotation panel's mutations (`webAnnotationCommand(...)` in about ten components) and their follow-up `refreshWebAnnotations(id, request)` calls name no scope, so they reach the command node and its engine; reads (sync, lists, threads, assets, captures, pins, drafts' local copy) are per scope. They move together when a leaf panel mounts (4001), the domain client taking a scope now (`webAnnotationCommand(…, undefined, scope)`). (2) Same for the design components' direct `designApi.*` calls (17, outside the controller): `designApiFor(scope)` is there for them. (3) `ServiceBrowserTab`'s desktop-tunnel `attachBrowserPreview` sends no `nodeId` yet (2009 left `lib/native/browser-preview.ts` to 2010's owner). (4) `useFilesPanel`'s `backend.refreshChanges` is command-bound (3007's module); its answer lands in the panel's scope's store.
- **Where Effect is used, and where not.** Not used directly. The stores are synchronous zustand creators; the engines' lifetimes are slots on 2001's Effect-backed scope lifetime, so their stops run as finalizers of that `Scope`. Their own timers and retries are unchanged (no `Schedule`: the backoffs are domain logic tested as is).
- **Outside the file set (minimal).** `lib/web-annotations/client.ts` and `lib/design-client.ts` (7004's, additive scope parameters after 7004 committed them); `hooks/useFilesPanel.ts`, `components/terminal/TerminalContainer.view.tsx`, `components/layout/useActionBarController.ts` (one call site each, committed without other agents' hunks); `docs/architecture/design-canvas.md` and `web-page-annotations.md` (one paragraph each).
- **For the report.** Appendix B's rows for `changes/subscriptions.ts`, `web-annotations/sync.ts` and `file-draft-persistence.ts` are now "per scope (slots)".
- **Aggregate suite** left to review preparation.

## Work log

- 2026-11-07 (claude-worker): converted the eight stores and registered them; moved the web annotation sync engines, asset reads, change subscriptions, preview sync, design controllers and file draft writes into per-scope slots stopped on dispose; scoped backend calls through `backendApiForScope` and 7004's domain clients (`designApiFor`, `webAnnotationCommand(…, scope)`); preview frames through the node client's preview URL; the imperative sites through `useShimNodeScope`/`useScopedStoreApi`; the local drafts' callers pass their node; 3005's config site in `DesignWorkspaceDialog`. Tests: new `stores/workflow-stores-b.test.tsx` (35: per store two scopes, hook under `renderInNodeScope`, statics on the command scope; barrel; a leaf's issues, PRs, previews and invalidations, preview URL, change projections, file drafts, canvas controller, annotation sync and persisted preferences go to the leaf and stop with its scope; object URLs revoked on dispose). Focused web runs: stores, lib/changes, draft persistence, github, pull-requests, files-panel, terminal, changes, environments, browser, settings, pane-layout, hooks, design, web-annotations (about 3,100 tests): pass except `EnvironmentRecoveryCopies.test.tsx` (2) and `useNotificationSoundService.test.tsx` (1), both in other agents' uncommitted files. `tests/unit/source-guards.test.ts`: fails only on other files' baseline findings and 3011's `coordinator-activity` barrel entry. Web typecheck: no errors in this item's files. fmt and oxlint clean on touched files.
