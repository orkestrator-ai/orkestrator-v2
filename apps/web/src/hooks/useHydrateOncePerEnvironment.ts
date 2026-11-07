import { useEffect, useRef } from "react";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useOptionalNodeScope } from "@/lib/node-scope/providers";

/** The key outside any scope (a test rendering without a provider). */
const NO_SCOPE = {};

/**
 * Restores a backend-owned list once per environment id of one node scope,
 * for the gap after a renderer exit or remount when its store starts empty.
 * Resource events and resyncs keep it current afterwards, so a status change
 * on the environment record must not refetch it. A failed restore is
 * forgotten and retried on the next change to the environment list.
 *
 * Per scope (plan item 3014): `scope` (by default the nearest provider's) is
 * the node the environments belong to, and the set of restored ids belongs to
 * it, so a different scope starts with nothing restored. `hydrate` closes over
 * the scope it reads (it is not passed in, so a reader with an optional second
 * parameter, such as a batcher, can be passed directly). The set is kept by the hook while the stores it restores are
 * command-scope singletons; it moves onto the scope with them (plan items 3010
 * and 3011).
 *
 * `hydrate` must be stable; it reports its own failure by rejecting.
 */
export function useHydrateOncePerEnvironment(
  environments: ReadonlyArray<{ id: string }>,
  hydrate: (environmentId: string) => Promise<unknown>,
  onError: (environmentId: string, error: unknown) => void,
  scope?: NodeScope,
): void {
  const nearest = useOptionalNodeScope();
  const owner: object = scope ?? nearest ?? NO_SCOPE;
  // One set per scope: a new scope (a replaced command scope) restores afresh.
  const restoredByScope = useRef(new WeakMap<object, Set<string>>());
  useEffect(() => {
    let restored = restoredByScope.current.get(owner);
    if (!restored) {
      restored = new Set();
      restoredByScope.current.set(owner, restored);
    }
    const current = new Set(environments.map((environment) => environment.id));
    for (const id of Array.from(restored)) {
      if (!current.has(id)) restored.delete(id);
    }
    for (const id of current) {
      if (restored.has(id)) continue;
      restored.add(id);
      const forget = restored;
      void hydrate(id).catch((error) => {
        forget.delete(id);
        onError(id, error);
      });
    }
  }, [owner, environments, hydrate, onError]);
}
