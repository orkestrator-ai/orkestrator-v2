# Node scopes: per-node stores, services and workspaces

The renderer holds one `NodeScope` per backend node it talks to, inside one
`WindowScope` per window (`apps/web/src/lib/node-scope/`; report
[§7](../reports/unified-federation.md#7-store-and-service-scoping), decision 13.2 B).
A per-node store has one instance per node scope instead of one module
singleton, so state for one node can never be read for another. How the
window holds, tiers and budgets those scopes is in
[federation.md](../architecture/federation.md#node-scopes-one-scope-per-node-in-the-windows-tree);
this page is the contributor's recipe.

**State (2026-11-07).** Every per-node store is a scoped store: the 39
modules in `apps/web/src/stores` that define a `defineScopedStore` def (plan
items 3001 and 3003–3013;
[`claudeOptionsStore`](../../apps/web/src/stores/claudeOptionsStore.ts) is the
worked example). The window's own stores (`WINDOW_STORES` in
`tests/source-guards/window-stores.ts`: the selection, chrome, dialogs, the
machine view, `remoteWorkspaceStore` and the like) stay ordinary zustand
stores that every node shares. The workspace realms that used to isolate
nodes are deleted (plan items 6002, 6003), so these scopes are the only thing
that keeps nodes apart in a window.

**The shim is gone (plan item 3018).** A per-node store is reached only
through a scope. Its hook (`scopedStoreHook(def)`) reads the nearest
`NodeScopeProvider` and has no `getState`/`setState`/`subscribe`/
`getInitialState` statics, so code that does not say which node it means no
longer compiles. Outside a provider the hook throws in development and tests;
a production build keeps `useNodeScope()`'s fallback to the app's command
scope, so a tree that lost its provider still behaves as the command node's.
Plan item 3001's migration shim (`scoped-store-shim.ts`: the deprecated
statics, the provider-less fallback, `useShimNodeScope`, `useScopedStoreApi`,
`noteShimUse`), the `scoped-store-shim` source guard that counted static
calls, and plan item 4004's runtime guard that watched shim uses under a
mounted leaf were deleted with it.

## The pieces

| Piece | Where | What it is |
| --- | --- | --- |
| `defineScopedStore<S>(name, (scope) => creator)` | `lib/node-scope/scoped-store.ts` | The store's definition. `name` is unique, bounded and stable, because it names the store in logs, guards and baselines. The creator is an ordinary zustand `StateCreator`, and it receives the `NodeScope`, whose `client` it calls. |
| `scope.store(def)` | `NodeScope` | The scope's `StoreApi<S>` instance, created on first use and dropped when the scope is disposed. Imperative code goes through this. |
| `useScopedStore(def, selector)` | `lib/node-scope/scoped-store.ts` | The strict hook. It reads the nearest `NodeScopeProvider` (`useNodeScope()`): it throws outside one in development and tests, and reads the app's command scope outside one in production. |
| `scopedStoreHook(def)` | `lib/node-scope/scoped-store.ts` | The hook every per-node store exports: `useScopedStore(def, selector)` called like a zustand hook (with no selector it returns the whole state), plus `def` for `scope.store(useFooStore.def)`. It has no statics. |
| `useNodeScope()` | `lib/node-scope/providers.tsx` | The nearest node scope, for imperative code in a component or hook: `useNodeScope().store(fooStore)`. Same provider rule as the hook. |
| `WINDOW_STORES` | `tests/source-guards/window-stores.ts` | The window stores. A repository test fails on a module in `stores/` that neither defines a scoped store (exporting its hook through `scopedStoreHook`) nor is listed here. |
| `createXApi(client)` | every `lib/backend/<x>.ts` | That file's command functions on `client`'s node (plan item 3002). `client` is anything with `invokeRaw` (a `NodeClient`). The file's named exports are `createXApi(commandBackendClient)`: the command-scope shim. |
| `scopeBackendClient(scope)`, `backendApiForScope(scope, createXApi, { getX })` | `lib/backend/client.ts` | A scope as a factory client (through `invokeInScope`, so the scope's prefetched cache applies), and one factory's functions for a scope, made once per scope. On the app's command scope both return the command-bound path, so suites that mock `@/lib/backend` still see the call. |
| `lib-backend-command-default` guard | `tests/source-guards/lib-backend-command-default.ts` | Counts uses of a `lib/backend` named export inside a module that defines a scoped store, service or slot, per `lib/backend` file and module. Its baseline only falls. |
| `renderInNodeScope`, `FakeNodeClient` | `apps/web/src/test/render-in-node-scope.tsx` | Renders a component inside a fresh window scope and node scope ([testing guide](testing-guide.md#rendering-inside-a-node-scope)). |
| `renderInAppCommandScope`, `renderHookInAppCommandScope`, `InAppCommandScope`, `appCommandStore(def)` | `apps/web/src/test/render-in-node-scope.tsx`, `apps/web/src/test/app-command-store.ts` | For suites that mock `@/lib/backend`: render (or `renderHook`, or wrap a `renderToStaticMarkup` element) under the app's own window and command scope, and seed or read that scope's store instance. |

## Adding or converting a store

Every per-node store is already converted, so this is the recipe for a new
per-node store, or for a window store that turns out to hold per-node state.
A store whose state is the window's whatever node is shown stays an ordinary
zustand store and goes into `WINDOW_STORES` (below). Take
`apps/web/src/stores/fooStore.ts`, exporting `useFooStore`. Do these steps in
one change.

1. **Define the store.** Replace `create<FooState>()((set, get) => ({ … }))`
   with a definition. Export the state type if tests need it.

   ```ts
   import { defineScopedStore, scopedStoreHook } from "@/lib/node-scope/scoped-store";

   export interface FooState { … }

   export const fooStore = defineScopedStore<FooState>("foo", (scope) => (set, get) => ({
     …,
     load: async (projectId) => {
       const list = await scope.client.invokeRaw<Foo[]>("list_foos", { projectId });
       set({ foos: list });
     },
   }));

   /** Reads the nearest node scope's foos; other code uses `scope.store(fooStore)`. */
   export const useFooStore = scopedStoreHook(fooStore);
   ```

   - The name is kebab-case and drops the `Store` suffix (`claude-options`,
     `environment`). It must be unique: a second def with the same name throws
     when both are used in one scope.
   - Inside the creator, call this node with `scope.client`, not with the
     global `invoke`/`listen` or a `lib/backend` named export, which is the
     command-scope shim. Build the file's functions for the scope instead:
     `const api = createEnvironmentsApi(scopeBackendClient(scope))` (or
     `createEnvironmentsApi(scope.client)`, which skips the scope's prefetched
     cache), then `api.listEnvironments()`. A named export left in the module
     is counted by the `lib-backend-command-default` guard (see
     [Rules the guards hold](#rules-the-guards-hold)).
   - A creator that starts its own work (a timer, a listener) registers its
     stop with `scope.onDispose(name, stop)` (invariant 15). Long-running work
     belongs in a scoped service (`defineScopedService`).
   - Module state next to the store (`let cache = …`) belongs in the store's
     state or in a scoped slot, not at module level. A companion module
     (`multi-review-persistence.ts`, `tab-launch.ts`) holds its maps, sets
     and timers in one `defineScopedSlot` (`lib/node-scope-slots.ts`), and
     each of its functions takes an optional trailing `scope` (the app's
     command scope when omitted, for callers with no scope yet). Callers that
     have one pass it. Hold the slot and `scope.store(def)` you read before an
     `await`, because the scope may be disposed by the time it answers. Clear
     the slot's timers with `scope.onDispose` (plan item 3003).
   - A persisted store wraps its creator in `persist` and keys it by its
     node: `name: nodeStorageKey("foo-storage", scope)` (`lib/persistence-keys.ts`;
     a `NodeScope` is a `StorageNode`). `persist` hydrates synchronously from
     `localStorage` when the scope first creates the store. Export the
     `merge` function, so tests check it without the `persist` API, which the
     def's `StateCreator<S>` type does not carry
     (`filesPanelStore`, `projectPullRequestsStore`).
   - A store with window state too (open state, widths) splits it into an
     ordinary window store (`filesPanelChromeStore`, `windowStorageKey`) that
     every node shares, and the scoped part.
   - The selection is the window's, node-qualified: `WindowScope.selection`
     (`stores/windowSelectionStore.ts`, plan item 3006). The scoped `uiStore`
     projects it (its `selectedProjectId` is null while another node is
     shown) and a selection made there moves it, so read "what does the
     window show" from the selection (`selectionOnScope(scope)`,
     `isCommandNodeSelection`), not from one node's store.
   - A store that holds heavy data (transcript history, previews) does not
     bound it per instance, which would multiply by the number of nodes
     (invariant 11). Each entry reserves its bytes from the window budget,
     `scope.budgets.transcripts` (or `artifacts`, `images`), under
     `(scope.nodeId, "<store>\0<key>")`, with an `onEvict` that drops the
     entry from this node's store. `nativeAgentProjectionStore` (plan item
     3009) keeps its reservations in step with its own state through a
     `subscribe` on its instance inside the creator, so any writer keeps the
     budget exact; a refused reservation drops the entry as an eviction
     would. The budget's policy decides what goes: other nodes' least
     recently used entries first, then this node's, never the shown node's.
     `ByteBudget.evictUntil(nodeId, key, target)` frees room best-effort for
     a reader that sizes its next request to what is left.

2. **Keep the barrel.** If `@/stores` (`apps/web/src/stores/index.ts`)
   re-exports the hook, export the def beside it:
   `export { fooStore, useFooStore } from "./fooStore";`.

3. **Name the scope at every imperative site.** The hook has no statics,
   so `useFooStore.getState()` does not compile. Write instead:

   | Where the call is | Write |
   | --- | --- |
   | A component or hook (anything `App` renders is under a provider) | `const scope = useNodeScope();` then `scope.store(fooStore).getState()` in the callback. Add `scope` to the callback's dependencies. |
   | Plain code a component calls | Add a `scope: NodeScope` parameter and pass `useNodeScope()` from the caller. |
   | Plain code that is the command node's by design (a module-level listener, a boot path) | Name it: `appCommandScope().store(fooStore)` (`lib/node-scope-slots.ts`). |
   | Inside the store's own creator | Use the creator's `get`/`set`. |

   Do not pass the hook where a `StoreApi` is expected (a `{ getState,
   subscribe }` parameter): pass `scope.store(fooStore)`.

4. **Write the tests** (next section), then run the store's suite, the suites
   of the components that read it, `tests/unit/source-guards.test.ts` (the
   store registry), `bun run --cwd apps/web typecheck`, `bun fmt` and `oxlint`
   on the touched files.

## Tests

- **The store's own test** names its scope. It needs no React:

  ```ts
  import { WindowScope } from "@/lib/node-scope/window-scope";
  import { FakeNodeClient } from "@/test/render-in-node-scope";

  let windowScope: WindowScope;
  let store: StoreApi<FooState>;
  beforeEach(() => {
    windowScope = new WindowScope();
    store = windowScope
      .open({ role: "command", client: new FakeNodeClient({ invoke: { list_foos: [] } }) })
      .store(fooStore);
  });
  afterEach(() => windowScope.dispose());
  ```

  Add one test that two scopes (`role: "leaf"` for the second) keep separate
  state. See `apps/web/src/stores/claudeOptionsStore.test.ts`.

- **Component tests** render with `renderInNodeScope` and seed or read the
  rendered scope's instance:

  ```tsx
  import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";

  afterEach(cleanupNodeScopes);

  const client = new FakeNodeClient({ invoke: { list_foos: [] } });
  const { scope } = renderInNodeScope(<FooList />, { client });
  act(() => scope.store(fooStore).setState({ foos: [foo] }));
  expect(client.calls("list_foos")).toHaveLength(1);
  ```

  Under `renderInNodeScope` the component reads the rendered scope, a fresh
  window's, never the app's. Seed state through `scope.store(def)`.

  A test-support module shared by several suites can own one scope per test
  and hand the suites accessors, as
  `components/build-pipeline/build-chat-tab-test-support.tsx` does (plan item
  3011): `buildChatScope()` opens it on first use, `pipelineStore()` is its
  pipeline store, `renderInBuildChat(ui)` renders into it (`renderInNodeScope`
  with that scope's window and client), and `cleanupBuildChatScope()` in
  `afterEach` drops it. Its `FakeNodeClient` answers the reads that now go to
  the scope's node (`get_build_pipeline`) by calling the suite's existing
  stubs, so their assertions keep working. Actions that still use the
  `@/lib/backend` named exports reach the module mocks as before.

- **Suites that mock `@/lib/backend`** (the named exports, which are the
  app's command scope's) render with `renderInAppCommandScope(ui, { wrapper })`
  or `renderHookInAppCommandScope(hook, options)`, and seed or read the same
  instance with `appCommandStore(fooStore)` (`@/test/app-command-store`).
  Reset between tests with `resetWindowScopeForTests()` in `afterEach`, which
  disposes the app's window scope, so the next test starts from fresh store
  state. A plain `render` of a component that reads a per-node store throws
  `useNodeScope() needs a NodeScopeProvider`: that is the strict check
  working, not a test to silence. A suite that mocks `@/stores` with a
  wrapper around a real hook captures the hook in a constant before the
  `mock.module` call, because the mock rebinds the import (see
  `components/layout/AppShell.test.tsx`).

- **Tiers** (plan item 4002): build the window with `new WindowScope({
  lifecycle: { host, suspendAfterMs, … }, lifecycleDeps: { clock, visibility,
  memoryWarnings, readHeap } })`, using `FakeLifecycleClock`, `FakeVisibility`
  and `FakeMemoryWarnings` from `lib/node-scope/lifecycle.test-support.ts`,
  and move the shown node with `windowScope.select(…)`. After
  `windowScope.dispose()` the clock has no pending timers. A component test on
  the app's window scope can drive the pressure path with
  `window.dispatchEvent(new Event("orkestrator:memory-warning"))`.

## Services, change feeds and reads per scope

Background work runs as scoped services (plan item 3014;
[`lib/scope-services.ts`](../../apps/web/src/lib/scope-services.ts)).
`defineScopedService(name, (scope, signal) => ({ stop, done? }))` starts once
per scope; `scope.service(def)` returns its handle, and disposing the scope
stops it. A service that throws on start, or whose `done` rejects, marks only
its own scope `failed`. `App` starts `COMMAND_SCOPE_SERVICES` for the command
scope with `startScopeServices(scope, services)`. A warm scope (plan item
4002) starts `WARM_SCOPE_SERVICES`: the change feed, the store bindings,
connectivity, the node's pane-layout persistence and its build-pipeline
completion notes (which open a tab in that node's pane layout, plan item 3013).

| Per scope | Window-level |
| --- | --- |
| The change feed (`resource-sync.ts`): handlers, coalescing, transport. Every function takes an optional trailing `scope`. | The read policy (`read-window-policy.ts`): visibility, host-hidden, data saving, return hints. |
| The read coordinator: `readCoordinatorFor(scope)`; `getReadCoordinator()` is the command scope's. | The connectivity aggregate (`useTransportConnectivity()`), for the title bar and banner. |
| Connectivity: `setTransportDisconnected(source, down, scope?)`, `getNodeConnectivity(scope)`. | `dataSavingReadPolicyService` (runs on the command scope). |

**Moving a store's change handlers.** `store-resource-sync.ts` binds the feed
to stores through `StoreResourceHandlers` registrations, one per store, in
`STORE_RESOURCE_HANDLERS`. When you scope a store, move its registration into
the store's module and switch it to `every-scope`:

```ts
export const fooResourceHandlers = defineStoreResourceHandlers("foo", "every-scope", (context) => {
  const store = context.scope.store(fooStore);
  context.onResourceChanged("foo", ({ id }) => store.getState().reload(id));
  context.onResync("dependents", (pass) => (pass.includes("foo") ? store.getState().loadAll() : undefined));
});
```

Then import it into `STORE_RESOURCE_HANDLERS` in place of the old one.
Calling `defineStoreResourceHandlers` from a module that `store-resource-sync.ts`
imports back is an import cycle (`import/no-cycle`). Such a module imports the
framework's types only (`import type { StoreResourceHandlers }`) and exports a
frozen `{ name, runsOn, register }` object, the shape the function returns:
see `lib/project-environment-resource-handlers.ts` (plan item 3004), which also
keeps the backend out of the store modules, and `lib/workflow-resource-handlers.ts`
(plan item 3011), whose build-pipeline and Multi Review handlers share one
registration because they share the hidden-window deferral and its retry
timer; each scope gets its own. Inside a registration, read with
`backendApiForScope(context.scope, createXApi, backend)` (`* as backend` from
`@/lib/backend`) and let a test's `context.options` override win.
`context` also gives `listen` (the scope's events), `onStop`, `disposed()`,
`requestResync` and `signal`. Resync phases run in order: `projects`, then
`environments` (one participant after another), then `dependents` (all at
once), then `layouts`. A `command-scope` registration never runs on another
node's scope, because it writes command-scope singletons.

## A node's workspace in the window's tree

Every other node's workspace renders in the window's own tree, on desktop,
browser and iOS: `RemoteWorkspaceRegion` renders `InTreeWorkspace` for it
(plan items 4001 and 6001). It is the only path: the separate per-node
workspace documents of earlier releases are deleted (plan items 6002 and
6003). The pieces:

| Piece | Where | What it does |
| --- | --- | --- |
| `holdInTreeScope(nodeId)` | `lib/federation/in-tree-scopes.ts` | Opens the node's leaf scope in the app's window scope (browser: the node-client registry; desktop: main's node scope through `window.orkestrator.node`), hands it to the window's lifecycle (below), which starts `WARM_SCOPE_SERVICES`, and counts holds. Releasing the last hold leaves the scope to its tiers. Nothing here cancels work on the node. `configureInTreeScopes` replaces the host, services and read hooks in tests. |
| `WindowScope.lifecycle` (`ScopeLifecycle`) | `lib/node-scope/lifecycle.ts`, `lifecycle-config.ts` | Tiers of managed scopes (plan item 4002, report §8.1): `warm` (hidden; reads paused through `setReadCoordinatorScopeHidden`), `live` (shown), `suspended` (hidden past the host's `suspendAfterMs`: services stopped, `client.suspend()`), back to `warm`/`live` with a resync when shown, and `summary` (disposed under pressure). Pressure order: a hidden node's byte-budget entries (`ByteBudget.evictNode`), then suspend, then dispose; never the shown node. Per-host defaults in `HOST_LIFECYCLE_DEFAULTS` (desktop 15 min, browser 5 min, iOS 2 min and on hidden), overridable through `WindowScopeOptions.lifecycle`. Hook points: `onScopeOpen` (snapshot hydration, 4003), `onTransition` and `tiers` (attention sources, 5001). The command scope is never managed and stays `live`. |
| `remoteWorkspaceStore`, `NodeWorkspaceHost` | `stores/remoteWorkspaceStore.ts`, `components/federation/NodeWorkspaceHost.tsx` | The window's request for each node it holds (`open(nodeId, WorkspaceRequest)`, `requests[nodeId]`, `openNodes`, `active`; types in `lib/federation/workspace-request.ts`). The node's host reads its request from the window's store and applies it on the node's stores once they have what it needs (`dialogHydrated`, plan item 4005); a host remounted on the same scope does not reopen a one-shot dialog. The sidebar, files panel and grouping are the window's stores (`useWindowGrouping`, `lib/federation/window-grouping.ts`), and the node's `uiStore` is the window's one selection (the host adds the Home flag and recents). |
| `NodeErrorBoundary` | `components/federation/NodeErrorBoundary.tsx` | One node's workspace shows a per-node error with Try again. It wraps the command node's content too. |
| `WorkspaceContent`, `useNodeWorkspaceServices`, `useNodeBootHydration` | `components/layout/WorkspaceContent.tsx` | The central region's content, its overlay start handlers, and the per-node background hooks. `App` and `InTreeWorkspace` both render them, each inside its own `NodeScopeProvider`. |
| `NodeWorkspaceLayout` | `components/layout/NodeWorkspaceLayout.tsx` | Another node's toolbar, content and files panel under the window's title bar, drawn by `InTreeWorkspace`. |
| Window features for the shown node (plan items 5002, 5003) | `lib/node-scope/shown-scope.ts`, `components/layout/ShownNodeTitleBar.tsx`, `components/bug-report/BugReportSheet.tsx`, `lib/app-shortcuts.ts` | `shownNodeScope()` is the scope of the node the window selection shows (`null` while that node's scope is still opening): `openPullRequestInApp` opens there by default. For another node `AppShell` draws the ordinary `SystemUsageIndicator` and `AgentInfoButton` inside its `NodeScopeProvider` (`useShownInTreeNode`, `NodeTitleBarUsage`, `NodeTitleBarAgentInfo`). `openBugReport` opens the window's sheet on the node (`bugReportStore.sheetNodeId`, `BugReportSheetHost`, `BugReportSheet scope`). Settings and app shortcuts run in the window's document; a workspace-owned shortcut runs only for the workspace on show (`onAppShortcut(id, handler, { workspace: scope })`, `setShownAppShortcutWorkspace`). `AppDialogHost` project dialogs wait for the node's first project list. |
| `backendForScope(scope)` | `lib/backend/scope-backend.ts` | Every `@/lib/backend` command function for one scope. On the app's command scope it is the module itself, so suites that mock it still see the call. Workspace components call it instead of a named export (see below). |

Components in the workspace subtree call their node, not the command node
(plan item 4007):

| In | Write |
| --- | --- |
| A component or hook | `const nodeBackend = useScopeBackend()` (`hooks/useScopeBackend.ts`, `backendForScope` of the nearest scope), then `nodeBackend.getX(...)` at call time; add it to the hook's dependencies. A file outside the `@/lib/backend` barrel: `useScopeApi(createXApi, x)` with `import * as x from "@/lib/backend/x"`. |
| Plain code a component calls | Take the node: a `NodeScope` parameter (`backendForScope(scope)` inside), or the narrow `Pick<ScopeBackend, "getX">` the code needs, passed from the caller's `useScopeBackend()`. 3003's optional trailing `scope` (command scope when omitted) is fine for helpers that also serve window code. |
| A `{ load = getX }` default parameter | `{ load: loadOverride }` and `const load = loadOverride === undefined ? nodeBackend.getX : loadOverride;` |
| Claude tmux | `useClaudeTmuxClient()` / `claudeTmuxClientFor(scope)` (`lib/claude-tmux-scope.ts`): the node's commands and its `claude-tmux:event` stream. |
| The design canvas | `useDesignScope()` / `useDesignApi()` (`components/design/design-scope.ts`), `designApiFor(scope)`. The design client has no command-bound default. |
| Graph-run view requests | `requestGraphRunView(request, scope)`, `onGraphRunViewRequested(listener, scope)`, `takePendingGraphRunView(environmentId, scope)`: per scope. |

The `workspace-command-bound-call` source guard holds this (see below). A
call that is the window's wherever it is made (`openInBrowser`) is listed in
`WORKSPACE_WINDOW_LEVEL_EXPORTS`, and a window-level module the workspace
imports in `WORKSPACE_EXEMPT_MODULES`, each with its reason. Prompt queues
and boot hydration are per node too: `createPromptQueueSources(scope)`, the
prompt-queue mutations' trailing `scope`, `environmentHydrationFor(scope)`,
and the `prompt-queues` change handler runs on every scope, so a leaf's tmux
tabs restore and follow the leaf's queues.

## Rules the guards hold

- A per-node store cannot be reached without naming its node: the hook has no
  statics (the types forbid `useFooStore.getState()`), and the strict check
  throws outside a provider in development and tests. The store registry
  test in `tests/unit/source-guards.test.ts` fails on a module in
  `apps/web/src/stores` that is neither a scoped store exported through
  `scopedStoreHook` nor listed in `WINDOW_STORES`, so per-node state cannot be
  added as a window-wide singleton by accident. Plan item 3018 retired the
  `scoped-store-shim` source guard (it counted statics, which no longer
  exist) and plan item 4004's runtime guard (it watched shim uses under a
  mounted leaf, and nothing reaches the shim any more). The multi-node e2e
  checks after every flow that no node workspace shows a render failure,
  which is where a provider-less hook lands in its development renderer.
- The `lib-backend-command-default` source guard counts each use of a
  `lib/backend` named export (the command-scope shim of plan item 3002) in a
  production module that defines a scoped store, service or slot, keyed
  `[lib/backend file] module`. It reads the shim names from the `lib/backend`
  sources (an exported `const` bound with `commandBackendClient` or
  `portalBackendClient`) and follows the import through `@/lib/backend` or any
  re-export. Factories, types and helpers that send nothing are not counted,
  nor is the command-scope fallback handed to `backendApiForScope`. A module
  enters the guard when it first defines scoped state, so the item converting
  it either moves its calls onto `createXApi(...)` or regenerates with
  `bun tests/source-guards/update-baseline.ts --guard lib-backend-command-default`
  and says why in its Notes.
- The `workspace-command-bound-call` source guard (plan item 4007,
  `tests/source-guards/workspace-command-bound-call.ts`) follows the value
  imports (static, re-exports, `import()`) from the workspace roots
  (`WorkspaceContent`, `NodeWorkspaceLayout`, `OpenFileDialog`,
  `AgentMailPanel`) and counts, in every module it reaches, each use of a
  command-bound export: a `lib/backend` named export, or any renderer
  module's export bound to `commandBackendClient`/`portalBackendClient`
  (`lib/claude-tmux-client`'s shim). Keys are `[subject] file`. It does not
  follow `lib/backend/**`, `lib/node-scope/**`, `src/test/**` or the
  modules in `WORKSPACE_EXEMPT_MODULES`. The baseline is zero (2026-11-07)
  and only falls; regenerate with `--guard workspace-command-bound-call`.
- Transports are reached only through a scope
  ([linting.md](linting.md#transports-only-through-a-scope)). A converted
  store calls `scope.client`, never `invoke`/`listen` directly.
