/**
 * The `nodes` domain on a `lib/backend` factory's client (plan item 7009):
 * `nodesApi(client).<command>(args)`. See `./domain-api.ts` for the adapter
 * choice (version 1 with the envelope for a node that advertises the domain,
 * today's untyped call otherwise).
 *
 * The portal's own modules (`lib/portal/*`, `lib/federation/node-events.ts`,
 * `lib/command-handover.ts`) call the command node through `portalInvoke` or
 * an injected invoke, not a negotiated client: {@link nodesApiOver} binds the
 * API to such a call. It carries no `domains`, so it always takes version 0,
 * which sends exactly today's `invoke(command, args)` and returns the answer
 * as sent; the calls are typed by the definitions.
 */
import { nodesClient, type NodesApi } from "@orkestrator/protocol/contract/domains/nodes";
import type { BackendClient } from "@/lib/backend/client";
import { portalInvoke } from "@/lib/portal/portal-transport";
import { domainApi } from "./domain-api";

export type { NodesApi } from "@orkestrator/protocol/contract/domains/nodes";

export function nodesApi(client: BackendClient): NodesApi {
  return domainApi(client, nodesClient);
}

/** A command call in `portalInvoke`'s shape. */
export type NodesInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const overInvoke = new WeakMap<NodesInvoke, BackendClient>();

/** The `nodes` API over a bare command call (version 0: today's untyped call). */
export function nodesApiOver(invoke: NodesInvoke): NodesApi {
  let client = overInvoke.get(invoke);
  if (!client) {
    client = {
      invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
        args === undefined
          ? invoke<T>(command)
          : invoke<T>(command, args as Record<string, unknown>),
    } as BackendClient;
    overInvoke.set(invoke, client);
  }
  return nodesApi(client);
}

/** The `nodes` API on the window's command node, over the portal channel. */
export function portalNodesApi(): NodesApi {
  return nodesApiOver(portalInvoke);
}

/** A call made today without an arguments object; version 0 sends exactly that. */
export const NO_ARGS = undefined as never;
