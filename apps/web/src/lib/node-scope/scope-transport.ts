/**
 * Calls through a node scope: the shared bodies of `@/lib/native/backend`
 * `invoke` and `@/lib/native/events` `listen`, which are these over the
 * window's command scope (plan item 2010), and what scoped code calls with
 * its own scope.
 *
 * Kept outside `lib/native/*` on purpose: `tests/setup.ts` replaces those two
 * modules for every suite, so anything they exported beyond today's names
 * would be missing under test.
 */

import { isNodeReadCommand } from "@orkestrator/protocol/command-nodes";
import type { NodeClient, NodeInvokeOptions } from "@orkestrator/protocol/node-client";
import type { NodeScope } from "./node-scope";
import { scopeMutationGate } from "./snapshot-sync";

/**
 * `command` on `scope`'s node. A read the scope's prefetched cache holds is
 * answered from it; anything else is first reported to the cache (a write
 * drops every primed snapshot) and then sent through the scope's client.
 *
 * While the scope shows a local snapshot that is being replaced (plan item
 * 4003, `snapshot-sync.ts`), a command that is not a read waits for `live`.
 */
export async function invokeInScope<T = unknown>(
  scope: NodeScope,
  command: string,
  args?: Record<string, unknown>,
  options?: NodeInvokeOptions,
): Promise<T> {
  const prefetched = scope.prefetched.read(command, args);
  if (prefetched.found) return prefetched.value as T;
  // A command no primed snapshot answered may be the write that invalidates
  // them. Report it before the round trip so a mutation cannot be overtaken by
  // a read that the batch primed earlier in the same reconciliation.
  scope.prefetched.noteInvocation(command);
  if (!isNodeReadCommand(command)) {
    const gate = scopeMutationGate(scope);
    if (gate) await gate;
  }
  return options
    ? scope.client.invokeRaw<T>(command, args, options)
    : scope.client.invokeRaw<T>(command, args);
}

/** The shape `listenOn` (`@/lib/native/events`) takes. */
export interface ClientEventSource {
  listen<T = unknown>(event: string, callback: (payload: T) => void): () => void;
  eventStreamReady(event: string): Promise<void>;
}

/** `client` as an event source for `listenOn`, so its readiness wait and abort apply. */
export function clientEventSource(client: NodeClient): ClientEventSource {
  return {
    listen: (event, callback) => client.listenRaw(event, callback),
    eventStreamReady: (event) => client.eventStreamReady(event),
  };
}
