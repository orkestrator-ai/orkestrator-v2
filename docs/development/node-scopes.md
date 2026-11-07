# Node scopes: converting a store

The renderer holds one `NodeScope` per backend node it talks to, inside one
`WindowScope` per window (`apps/web/src/lib/node-scope/`; report
[§7](../reports/unified-federation.md#7-store-and-service-scoping), decision 13.2 B).
A converted store has one instance per node scope instead of one module
singleton, so state for one node can never be read for another. Stores are
converted one at a time (plan items 3003–3013). This page is the recipe each
of those items follows. [`claudeOptionsStore`](../../apps/web/src/stores/claudeOptionsStore.ts)
is the worked example (plan item 3001).

## The pieces

| Piece | Where | What it is |
| --- | --- | --- |
| `defineScopedStore<S>(name, (scope) => creator)` | `lib/node-scope/scoped-store.ts` | The store's definition. `name` is unique, bounded and stable, because it names the store in logs, guards and baselines. The creator is an ordinary zustand `StateCreator`, and it receives the `NodeScope`, whose `client` it calls. |
| `scope.store(def)` | `NodeScope` | The scope's `StoreApi<S>` instance, created on first use and dropped when the scope is disposed. Imperative code goes through this. |
| `useScopedStore(def, selector)` | `lib/node-scope/scoped-store.ts` | The strict hook. It reads the nearest `NodeScopeProvider`, and it throws outside one in development and tests. |
| `scopedStoreHook(def)` | `lib/node-scope/scoped-store-shim.ts` | The migration hook. It is called like the old zustand hook, reads the nearest node scope, and falls back to the command scope outside a provider. It keeps `getState`, `setState`, `subscribe` and `getInitialState` as `@deprecated` statics on the **command scope's** instance. |
| `noteShimUse(store, via)` | `lib/node-scope/scoped-store-shim.ts` | Called by every shim use: each static, and the hook when it falls back. It does nothing until plan item 4004 installs the runtime guard (`setShimUseObserver`). |
| `scoped-store-shim` guard | `tests/source-guards/scoped-store-shim.ts` | Counts static calls on a converted hook, per store and per file. Its baseline only falls. |
| `createXApi(client)` | every `lib/backend/<x>.ts` | That file's command functions on `client`'s node (plan item 3002). `client` is anything with `invokeRaw` (a `NodeClient`). The file's named exports are `createXApi(commandBackendClient)`: the command-scope shim. |
| `scopeBackendClient(scope)`, `backendApiForScope(scope, createXApi, { getX })` | `lib/backend/client.ts` | A scope as a factory client (through `invokeInScope`, so the scope's prefetched cache applies), and one factory's functions for a scope, made once per scope. On the app's command scope both return the command-bound path, so suites that mock `@/lib/backend` still see the call. |
| `lib-backend-command-default` guard | `tests/source-guards/lib-backend-command-default.ts` | Counts uses of a `lib/backend` named export inside a module that defines a scoped store, service or slot, per `lib/backend` file and module. Its baseline only falls. |
| `renderInNodeScope`, `FakeNodeClient` | `apps/web/src/test/render-in-node-scope.tsx` | Renders a component inside a fresh window scope and node scope ([testing guide](testing-guide.md#rendering-inside-a-node-scope)). |

## Converting one store

Take `apps/web/src/stores/fooStore.ts`, exporting `useFooStore`. Do these
steps in one change.

1. **Define the store.** Replace `create<FooState>()((set, get) => ({ … }))`
   with a definition. Export the state type if tests need it.

   ```ts
   import { defineScopedStore } from "@/lib/node-scope/scoped-store";
   import { scopedStoreHook } from "@/lib/node-scope/scoped-store-shim";

   export interface FooState { … }

   export const fooStore = defineScopedStore<FooState>("foo", (scope) => (set, get) => ({
     …,
     load: async (projectId) => {
       const list = await scope.client.invokeRaw<Foo[]>("list_foos", { projectId });
       set({ foos: list });
     },
   }));

   /** Reads the nearest node scope's foos. The statics are the deprecated command-scope shim. */
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
     state or in a scoped slot, not at module level.

2. **Keep the barrel.** If `@/stores` (`apps/web/src/stores/index.ts`)
   re-exports the hook, export the def beside it:
   `export { fooStore, useFooStore } from "./fooStore";`.

3. **Register the store with the guard.** Add one entry to `SHIMMED_STORES`
   in `tests/source-guards/scoped-store-shim.ts`:

   ```ts
   { store: "foo", module: "apps/web/src/stores/fooStore", hook: "useFooStore" },
   ```

   `store` is the def's name and `module` is the file path without its
   extension. A repository test fails if a `scopedStoreHook` export is not
   registered, or a registration names no converted store.

4. **Leave hook call sites alone.** `useFooStore((s) => s.x)` compiles and
   behaves as before: it reads the nearest node scope, which is the command
   scope everywhere the app renders today.

5. **Convert the imperative sites you can.** Each
   `useFooStore.getState()`, `setState`, `subscribe` or `getInitialState`
   outside tests is a shim use. It does not say which node it means, so it
   reaches the command node. Change it to name its scope:

   | Where the call is | Write instead |
   | --- | --- |
   | A component or hook under a provider (anything `App` renders) | `const scope = useNodeScope();` then `scope.store(fooStore).getState()` in the callback. Add `scope` to the callback's dependencies. |
   | Plain code a component calls | Add a `scope: NodeScope` parameter and pass `useNodeScope()` from the caller. |
   | Plain code with no caller that has a scope yet (a module-level listener, a boot path) | Leave it. It stays in the baseline until its own item threads a scope through. |
   | Inside the store's own creator | Use the creator's `get`/`set`, not the hook's statics. |

   Do not keep `const api = useFooStore` aliases or destructure the statics
   (`const { getState } = useFooStore`) to dodge the guard. The guard counts
   destructuring, and aliases defeat review.

6. **Update the baseline for this guard only.**

   ```bash
   bun tests/source-guards/update-baseline.ts --guard scoped-store-shim
   ```

   This rescans only the `scoped-store-shim` guard and keeps every other
   guard's committed entries byte for byte, so it cannot admit unrelated
   findings elsewhere in the tree. It prints the total per store. Check that
   the diff of `tests/source-guards/baseline.json` touches only your store's
   `[foo] …` entries. Record the store's total in the item's Notes (for
   example "`foo`: 37 shim uses in 12 files, 2026-11-07"). Never run the
   command without `--guard`, and never use it to admit a new call. A
   regeneration that raises an entry is justified only when a rewrite moved
   an existing call between files.

7. **Move the tests** (next section), then run the store's suite, the suites
   of the components that read it, `tests/unit/source-guards.test.ts`,
   `bun run --cwd apps/web typecheck`, `bun fmt` and `oxlint` on the touched
   files.

### Retiring the shim for a store

Once the store's baseline is zero and its tests no longer use the statics,
the item may change the hook to the strict form:

```ts
export const useFooStore = <U>(selector: (state: FooState) => U) => useScopedStore(fooStore, selector);
```

Then remove the store's `SHIMMED_STORES` entry in the same change. Any test
that still renders a reader without a provider then fails loudly, which is
the point.

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

  Under `renderInNodeScope` the component reads the rendered scope. The
  deprecated statics reach the **app's** command scope, a different instance,
  so a test that mixes them sees nothing change. Seed state through
  `scope.store(def)`.

- **Tests that render without a provider** (plain `render`) still work while
  the shim is in place. The hook falls back to the app's command scope, which
  is the same instance the statics use. They may keep `useFooStore.setState(…)`
  for now (test files are not counted). Reset between tests with
  `resetWindowScopeForTests()` in `afterEach`, which disposes the app's window
  scope, so the next test starts from fresh store state. That replaces
  resetting the old singleton by hand. Move them to `renderInNodeScope` before
  retiring the shim.

- **Testing the shim itself**: `setShimUseObserver((use) => uses.push(use))`
  returns a restore function. Call it in `afterEach`.

## Rules the guards hold

- The `scoped-store-shim` source guard (`tests/unit/source-guards.test.ts`)
  fails on a static call in a file or for a store where the baseline allows
  fewer, and on a baseline entry above the real count until the baseline is
  regenerated smaller. It finds the store from the import, never from the
  identifier's spelling. Direct imports, aliases (`as`), the `@/stores` barrel,
  other re-exporting modules (`export { … } from`, `export * from`, import
  then export), namespace imports and the store module's calls on itself are
  all counted. Test files and test-support modules are not.
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
- At runtime, plan item 4004 turns `noteShimUse` into a guard. A shim use for
  a store the shown leaf's workspace uses throws in development and tests
  while an in-tree leaf is mounted. Phase 4 cannot mount a leaf in-tree until
  every store its workspace touches has a zero baseline.
- Transports are reached only through a scope
  ([linting.md](linting.md#transports-only-through-a-scope)). A converted
  store calls `scope.client`, never `invoke`/`listen` directly.
