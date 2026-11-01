import { useEffect, useRef } from "react";

/**
 * Restores a backend-owned list once per environment id, for the gap after a
 * renderer exit or remount when its store starts empty. Resource events and
 * resyncs keep it current afterwards, so a status change on the environment
 * record must not refetch it. A failed restore is forgotten and retried on the
 * next change to the environment list.
 *
 * `hydrate` must be stable; it reports its own failure by rejecting.
 */
export function useHydrateOncePerEnvironment(
  environments: ReadonlyArray<{ id: string }>,
  hydrate: (environmentId: string) => Promise<unknown>,
  onError: (environmentId: string, error: unknown) => void,
): void {
  const restored = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(environments.map((environment) => environment.id));
    for (const id of Array.from(restored.current)) {
      if (!current.has(id)) restored.current.delete(id);
    }
    for (const id of current) {
      if (restored.current.has(id)) continue;
      restored.current.add(id);
      void hydrate(id).catch((error) => {
        restored.current.delete(id);
        onError(id, error);
      });
    }
  }, [environments, hydrate, onError]);
}
