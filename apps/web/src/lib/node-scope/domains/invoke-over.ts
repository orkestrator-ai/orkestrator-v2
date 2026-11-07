/**
 * A `lib/backend` factory client over a bare command call (plan item 7009),
 * for callers that reach a node through something other than a negotiated
 * client: the window's command scope (`commandScopeInvoke`), `invoke_on_node` routing to another machine, or
 * an injected machine call. The client carries no `domains`, so every domain
 * client over it takes version 0, which sends exactly today's
 * `invoke(command, args)` (or `invoke(command)` for {@link NO_ARGS}) and
 * returns the answer as sent; the calls are typed by the definitions.
 */
import type { BackendClient } from "@/lib/backend/client";

/** A command call in `commandScopeInvoke`'s shape. */
export type CommandInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const clients = new WeakMap<CommandInvoke, BackendClient>();

/** The factory client over `invoke`, made once per function. */
export function backendClientOver(invoke: CommandInvoke): BackendClient {
  let client = clients.get(invoke);
  if (!client) {
    client = {
      invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
        args === undefined
          ? invoke<T>(command)
          : invoke<T>(command, args as Record<string, unknown>),
    } as BackendClient;
    clients.set(invoke, client);
  }
  return client;
}

/** A call made today without an arguments object; version 0 sends exactly that. */
export const NO_ARGS = undefined as never;
