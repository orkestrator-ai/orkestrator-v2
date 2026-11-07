/**
 * The command scope's prefetched-command cache, for code that is not scoped
 * yet (`resource-sync`, the `@/lib/native/backend` `invoke` wrapper).
 *
 * The cache itself (`PrefetchedCommandCache`) is per node scope: each
 * `NodeScope` owns one as `scope.prefetched` and drops it on dispose (plan
 * item 2010). These functions act on the window's command scope, which is the
 * scope today's single-backend `invoke` talks to; scoped code uses its own
 * scope's cache through `invokeInScope`.
 */

import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { PrefetchedCommandCache } from "@/lib/node-scope/prefetched-command-cache";

export {
  PrefetchedCommandCache,
  PREFETCHED_COMMAND_RESPONSE_TTL_MS,
} from "@/lib/node-scope/prefetched-command-cache";

function commandCache(): PrefetchedCommandCache {
  return getWindowScope().commandScope().prefetched;
}

export function primePrefetchedCommandResponses(
  entries: ReadonlyArray<{ command: string; args: Record<string, unknown>; snapshot: unknown }>,
  options: { ttlMs?: number } = {},
): () => void {
  return commandCache().prime(entries, options);
}

export function readPrefetchedCommandResponse(
  command: string,
  args: Record<string, unknown> | undefined,
): { found: boolean; value?: unknown } {
  return commandCache().read(command, args);
}

/** See {@link PrefetchedCommandCache.noteInvocation}. */
export function notePrefetchedCommandInvocation(command: string): void {
  commandCache().noteInvocation(command);
}

/** Drops every primed snapshot. Used by teardown and by tests. */
export function clearPrefetchedCommandResponses(): void {
  commandCache().clear();
}
