/**
 * A per-node store's instance in the app's command scope, for tests. Test-only.
 *
 * ```ts
 * import { appCommandStore } from "@/test/app-command-store";
 * import { environmentStore } from "@/stores/environmentStore";
 *
 * appCommandStore(environmentStore).setState({ environments: [env] });
 * renderInAppCommandScope(<EnvironmentList />);
 * ```
 *
 * The instance is the one `renderInAppCommandScope` renders under and the one
 * code that names the app's command scope (`getWindowScope().commandScope()`)
 * reaches, so a suite seeds and reads it here. It is looked up at each call:
 * after `resetWindowScopeForTests()` it is the new command scope's instance.
 * A suite with a scope of its own (`renderInNodeScope`) uses
 * `scope.store(def)` instead.
 */

import type { StoreApi } from "zustand/vanilla";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { ScopedStoreDef } from "@/lib/node-scope/scoped-store";

export function appCommandStore<S>(def: ScopedStoreDef<S>): StoreApi<S> {
  return getWindowScope().commandScope().store(def);
}
