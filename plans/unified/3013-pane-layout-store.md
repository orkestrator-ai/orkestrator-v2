---
id: 3013
title: "Convert paneLayoutStore and its persistence services (last)"
phase: 3
plan: "§12 Phase 3.6"
status: in-progress
depends_on: [3006, 3007, 3008, 3009, 3010]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3013 · Convert paneLayoutStore and its persistence services (last)

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3006](3006-ui-store-split.md), [3007](3007-files-panel-split.md), [3008](3008-terminal-portal-and-artifact-hosts.md), [3009](3009-agent-and-transcript-stores.md), [3010](3010-sessions-terminals-tmux-mail.md)
- **Blocks:** [4001](4001-in-tree-workspace-seam.md)
- **Size:** L
- **Track:** S (scopes), critical path

## Goal

The largest and most connected store is per node. After this item, the workspace subtree has no shim calls.

## Current state (verified 2026-11-07)

- `paneLayoutStore`: 1,852 LOC; 88 imperative sites, 45 of them in `.ts`; 40 direct importers; 72 test files.
- It calls `terminalSession`, `claudeTmux`, `nativeCompose` and `terminalPortal`: 10 `getState` calls at :368, 426, 458, 488, 506, 511, 648, 854, 869 and 1760.
- It imports `@/lib/backend`, `agent-handoff`, `tab-teardown-notice` and `browser-preview`.
- The default pane id is `"default"`, and tab ids are time-and-counter strings (§7.1). These collide across nodes, which is why the plan uses per-node instances.
- Companions:
  - `pane-layout-persistence.ts`: 910 LOC, 4 singletons; started in `App.tsx:367`.
  - `pane-layout-authoritative.ts`: 669 LOC, 3 singletons, 12 sites.
  - `pane-selection-storage.ts`: 495 LOC.

## Work

- [x] Convert the store. Its calls to the four other stores go through `scope.store(def)`.
- [x] Turn persistence and authoritative adoption into scoped services, with pending activations per scope.
- [x] Make pane selection storage keys per node ([3015](3015-persistence-keys-per-node.md)).
- [x] Bring the shim baseline to zero for every store the workspace subtree touches. List those stores in Notes, derived from the import graph of the `Workspace` component.

## Tests

- [x] Two scopes with `"default"` panes and identical tab ids stay independent; layout persistence round-trips per node; authoritative adoption after reload.

## Done when

- [x] The shim baseline is zero for the workspace subtree.
- [x] `test:agent:browser` passes with only the command scope: 2026-11-07 at `ee73894da`, 53 passed, the only failure the vim case that fails at base `148e9ad0a` on this host (see Work log). *(Split 2026-11-07 from "`mise run test` and `test:agent:browser` pass with only the command scope".)*
- [ ] `mise run test` passes with only the command scope (the orchestrator runs it at the end).

## Notes

- **API (2026-11-07).**
  - `stores/paneLayoutStore.ts`: `paneLayoutStore = defineScopedStore<PaneLayoutState>("pane-layout", (scope) => …)`, `usePaneLayoutStore = scopedStoreHook(paneLayoutStore)`, `PaneLayoutState` exported; def in the `@/stores` barrel and in `SHIMMED_STORES`. Actions unchanged. Tab teardown is the scope's: `scope.store(terminalSessionStore | claudeTmuxStore | nativeComposeStore)`, terminal portals by `scope.nodeId` (3008's five sites), `forgetAgentHandoff(id, scope)` (3009's request), `teardown_tab` and the handoff capability/prune reads through `backendApiForScope(scope, createTerminalsApi | createAgentHandoffsApi, …)`.
  - `lib/pane-layout-persistence.ts`: `startPaneLayoutPersistence(options, scope)` mirrors `scope.store(paneLayoutStore)` to `scope`'s node (`getPaneLayout`/`savePaneLayout`/`applyPaneLayoutIntent` through `backendApiForScope(scope, createFilesSessionsApi, …)`), hydrates dependencies, reconciles, commits handoffs and keeps the window pane selection on `scope`. `flushPaneLayoutNow(id, input, save?, load?, scope?)` and `migratePaneLayoutBrowserHistory(id, snapshot, save?, scope?)`: `save`/`load` are now optional (the scope's commands when omitted). `paneLayoutPersistenceService` runs on any scope.
  - `lib/pane-layout-authoritative.ts`: the pending tab activations and the two install-commit maps are one `defineScopedSlot("pane-layout-activations")`. Every export takes an optional trailing `scope` (3003's convention): `armStartupAgentTabActivation`, `clearStartupAgentTabActivation`, `armBuildPipelineTabActivation`, `clearBuildPipelineTabActivation`, `clearBuildPipelineHandoffResolutions`, `commitStartupAgentSetupHandoff(id, state, scope?)`, `commitBuildPipelineSetupHandoff(id, state, scope?)`, `requestPaneTabActivation(id, tabId, scope?)`, `cancelPaneTabActivation(id, tabId?, scope?)`, `flushPaneTabActivation(id, scope?)`, `hydratePaneLayoutDependencies(root, scope?)` (passes the scope to `hydrateBuildPipeline`/`isBuildPipelineKnownUnavailable`/`hydrateMultiReviewWorkflow`/`isMultiReviewWorkflowKnownUnavailable`, reads `scope.store(buildPipelineStore | multiReviewStore)`), `reconcileAuthoritativePaneLayout(id, saved, current, scope?)` (environments from `scope.store(environmentStore)`). Every pane-selection-storage call passes the scope as its storage node.
  - `lib/store-resource-sync.ts`: the `pane-layout` registration is `every-scope`, rewritten in place (as 3005/3010): `scope.store(paneLayoutStore)`, `get_pane_layout` through `backendApiForScope(scope, createFilesSessionsApi, { getPaneLayout })` (read per call; a test's `options.getPaneLayout` still wins), and the scope passed to hydration, reconciliation, the activation flush and the handoff commits.
  - `lib/scope-services.ts`: `WARM_SCOPE_SERVICES` = resource-sync, store-resource-sync, transport-connectivity, pane-layout persistence, completion notes; `COMMAND_SCOPE_SERVICES` = those plus data-saving and window-selection persistence.
  - `lib/build-pipeline-completion-notes.ts`: opens the notes in `scope.store(paneLayoutStore)`; no command-only check (3011's open box, ticked there).
  - `lib/coordinator-work-navigation.ts`: the slot holds `scope` and `scope.store(paneLayoutStore)`; focus goes through `openConversationTab(…, scope)` and `requestPaneTabActivation(…, scope)`.
  - Open-tab helpers take a required `scope` option: `openKeyInformationTab`, `openDesignCanvasTab`, `openGraphDesignerTab`, `openGraphRunTab`. `handoffSetupFocusToStartupAgent(id, state, tabId, scope)`. `readDesignLayoutFacts(layouts, id)`.
  - Optional trailing `scope` (command scope when omitted): `lib/web-annotations/navigation.ts` (`openWebAnnotationThread(id, annotationId, options?, scope?)`, `openWebAnnotationRequest(id, requestId, scope?)` (its read through `webAnnotationCommand(…, undefined, scope)`), `openConversationTab`, `isConversationTabOpen`, `openNewAgentSession`), `openConversationAtMessage(ref, target, scope?)`, `handTabInitialPromptToBackend(input, enqueue?, scope?)` (queue through `backendApiForScope(scope, createWorkflowsApi, …)`, drafts and tab on the scope), `cleanupDeletedEnvironmentSubscriptions(id, scope?)`, `openPullRequestInApp(ref, view?, scope = appCommandScope())`. `tab-launch`'s slot watches `scope.store(paneLayoutStore)` and passes its scope to the activation calls.
  - Terminal links: `createTerminalLinkActivator({ …, scope?: () => NodeScope })` reads the default target from that scope's config and opens a pull request in its files panel; `CreateXtermTerminal`'s link source carries the terminal's `nodeId` (set by `terminalPortalStore`), which `terminal-xterm.ts` resolves per click through the app window's registry (`getWindowScope().get(nodeId)`, the command scope when the node is gone). `openLinkExternally` reads `scope.store(environmentStore)`; `ClaudeTmuxInteractiveTerminal` and `MarkdownLink` pass their scope.
  - `TerminalContainer.view` hydration reads and deletes the layout on its own node (`backendApiForScope(paneLayoutScope, createFilesSessionsApi, …)`) and passes its scope to dependency hydration, selection storage, history migration and `flushPaneLayoutNow`.
- **Decision: where persistence and completion notes run (2026-11-07).** Options: (a) a third "live" service set for 4002; (b) `WARM_SCOPE_SERVICES`. A warm scope's store bindings already adopt that node's authoritative layouts (the registration is `every-scope`), and its completion notes add a tab to its layout, which only persistence writes back; without persistence there a warm node's notes tab would never be saved. Persistence is light (one store subscription and two window listeners per scope; writes happen only on layout changes). Chosen (b); 4002 may move them to a live tier if it defines one.
- **Decision: authoritative adoption and pending activations (2026-11-07).** The item asks for scoped services. Adoption already runs inside a scoped service (the `pane-layout` registration of `store-resource-sync`, now `every-scope`, plus the persistence service's adopt hook per scope), so no third service was added; the pending activations and install commits are a scoped slot (3011's slot-not-service decision: nothing runs on its own). The persistence write chain stays in the service closure (one per running service), its enqueue/adopt hooks in 3014's slot.
- **Decision: window-level readers name the command scope (2026-11-07).** Notification sounds (`notification-sounds.ts`, `useNotificationSoundService`) and the desktop question notification are the window's, for the node it is connected to, so they read `appCommandScope().store(configStore | environmentStore | projectStore)` explicitly (3006's convention), not the deprecated statics.
- **Deviation: the browser preview stays keyed by tab id (2026-11-07).** `destroyBrowserPreview(tab.id)` is the desktop's native preview view (window state), keyed by tab id alone; two nodes' identical tab ids could collide there once a leaf renders in-tree. Not changed here (it is not a store and not a node call); 4001 or a follow-up should key it by node.
- **Workspace subtree (2026-11-07), derived from the import graph.** There is no `Workspace` component yet (4001 creates it); the workspace is what `App` renders in its main area: `TerminalContainer` (an environment) and the lazy `ProjectWorkspace` (a project board). Their value-import closure (static and dynamic `import()`, type-only imports excluded; script `output/agent-testing/3013/workspace-stores.ts`) is 940 modules and reaches **all 39 shimmed stores**: agent-activity, agent-mail, agent-model-catalog, build-pipeline, change-projection, claude-options, claude-tmux, config, coordinator-activity, coordinator-launch-override, coordinator-pane-layout, design, environment, environment-diff, feature-plan, file-dirty, files-panel, github-issues, graph-describe, graph-designer, graph-run, kanban, multi-review, native-agent-projection, native-compose, pane-layout, pr-monitor, preview-service, project, project-pull-requests, prompt-draft, pull-requests, session, tab-launch, terminal-session, ui, web-annotation, web-annotation-preferences, worktree-snapshot. 4004's runtime guard should use this set.
- **Shim counts (`scoped-store-shim`, 2026-11-07).** `pane-layout` at registration: 98 in 34 files (the item counted 88); now **0**. Also to 0: `terminal-session` 1, `claude-tmux` 2, `native-compose` 4 (`paneLayoutStore` 2, `tab-initial-prompt`, `CoordinatorPanel`), `environment` 8 (`pane-layout-authoritative` 4, `question-desktop-notification` 2, `preview-link-external`, `web-annotations/navigation`), `multi-review` 2, `build-pipeline` 2, `config` 3 (`terminal-links`, `notification-sounds`, `useNotificationSoundService`), `files-panel` 1 (`pull-request-opener`), `project` 1. **Left anywhere in the tree: `[ui] components/federation/WorkspaceRealmHost.tsx` 2**, outside the workspace closure: a realm document's report of its own selection and its handling of the window's request (3006's note), realm-only code that 6002 deletes, and another agent has uncommitted work in the file. So the baseline is zero for every file of the workspace subtree; store-wide it is zero for 38 of the 39 stores, and `ui` keeps those 2 realm-only uses until 6002.
- **`lib-backend-command-default` (2026-11-07).** `[files-sessions] pane-layout-persistence.ts` 6 → 0, `[files-sessions] store-resource-sync.ts` 1 → 0. Left: `[projects-environments] lib/scope-services.ts` 3, the app command scope's explicit manifest reads in `scopeResourceSyncOptions` (3014's branch, which suites mock), not a shim of this item's stores.
- **The shim is not retired** for `pane-layout`: about 70 suites still seed it through the statics (they render without a provider, which the shim allows). Retiring it means moving them to `renderInNodeScope` first.
- **Where Effect is used, and where not.** Not used. The store is synchronous zustand state read in render; the activation slot, the persistence hooks and the navigation slot live on the scope's Effect-backed lifetime (`defineScopedSlot`, `scope.onDispose`), and the services are 3014's scoped services (child Effect `Scope`s). Nothing here needed a `Schedule` or a typed failure: the write chain and its CAS retry loop are unchanged.
- **Outside the file set (minimal).** `lib/scope-services.ts` (the two service lists) and its test, `stores/terminalPortalStore.ts` (the link source's `nodeId`), `components/layout/ActionBar.test.tsx` (the activation mock records the environment and tab only), `docs/development/node-scopes.md` (the warm set). Store-call sites in components, hooks and libs listed above.
- **For the orchestrator/report.** §7.4 can say the pane-layout persistence and completion notes are warm-scope services. 4004: the workspace-subtree store set is above (every shimmed store). 4001: key the native browser preview by node.
- Aggregate suite (`mise run test`) and `test:agent:browser` left to review preparation.
- **Status (2026-11-07, orchestrator, completeness check).** Open only for the aggregate `mise run test` box, which the orchestrator runs at the end of the branch; everything else is done.

## Work log

- 2026-11-07 (claude-worker): converted `paneLayoutStore` to a scoped def with the shim hook (barrel, `SHIMMED_STORES`), its tab teardown onto the scope's stores, portals, handoffs and node; pane-layout persistence, the authoritative reconcile and activations, the `pane-layout` change handler, completion notes, coordinator navigation, tab launches and every other caller per scope; persistence and completion notes in `WARM_SCOPE_SERVICES`; pane selection storage keyed by the scope's node; the remaining shim uses of other stores in the workspace subtree (terminal links, external links, PR opener, notifications, `CoordinatorPanel`, `tab-initial-prompt`). Shim baseline: `pane-layout` 98 → 0 and every other store of the subtree to 0; only `[ui] WorkspaceRealmHost.tsx` 2 (realm-only) remains anywhere. Tests: new `stores/paneLayoutStore.scopes.test.tsx` (6: two nodes' "default" panes and identical tab ids independent, teardown and sessions on the own node; the hook reads the rendered scope, barrel and statics; a pending activation is the node's own; persistence round-trips per node with per-node window selection; a leaf adopts its own node's authoritative layout after a reload without echoing it; a leaf's completion notes open in its own layout); updated `scope-services.test.ts` (persistence and notes run on the leaf; the failure-isolation case uses the data-saving service), `store-resource-sync.test.ts`, `ActionBar.test.tsx` and the three open-tab suites. Whole web suite (`bun --cwd=apps/web test src --parallel=4`): pass. `tests/unit` suites touching the changed modules pass alone, except pre-existing failures (`HierarchicalSidebar` uses `useUIStore.getState().setEnvironmentSortMode`, moved to `uiChromeStore` by 3006; `uncovered-stores` and `useEnvironments` as recorded by 3010). Web typecheck: no errors in touched files (other agents' in-flight files have some). fmt and oxlint clean on touched files.
- 2026-11-07 (claude-worker, 4006): browser smoke `mise run test:agent:browser` at `4ece07c9a` against `uf-4006-smoke` (started as the isolated runner starts its own, flags and environment): 52 passed, 2 failed, 124 skipped. Failures: `terminal-input-resume.spec.ts` "a lost terminal write stays fenced …" (the vim status-line pattern that fails at base `148e9ad0a` on this host: pre-existing, environmental) and `browser-gateway.spec.ts` "capped file tree … across inactive views and reload" (390 px after a reload the projects drawer stays open after selecting the environment; passed at `6860254e8`, so a branch regression since; details in [4006](4006-multi-node-qualification.md) Notes). The smoke box stays open.
- 2026-11-07 (claude-worker, 4006 fixes): browser smoke `mise run test:agent:browser` at `ee73894da` against `uf-fix-smoke` (started as the isolated runner starts its own, flags and environment): 53 passed, 1 failed, 124 skipped. The one failure is `terminal-input-resume.spec.ts` "a lost terminal write stays fenced …" (the vim status-line pattern that fails at base `148e9ad0a` on this host: pre-existing, environmental); the capped-file-tree regression is fixed (`e46872643`). Results: `output/agent-testing/uf-fix/evidence/smoke/results.json`; details in [4006](4006-multi-node-qualification.md) Notes.
- 2026-11-07 (orchestrator, completeness check): the ticked Done-when box claimed `mise run test` passes, but no aggregate run is recorded. Split it: the proven part stays ticked, "`mise run test` passes" is its own open box (the orchestrator runs it at the end). `status: in-progress` until then.
