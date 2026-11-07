/**
 * The `nodes` domain on a `lib/backend` factory's client (plan item 7009):
 * `nodesApi(client).<command>(args)`. See `./domain-api.ts` for the adapter
 * choice (version 1 with the envelope for a node that advertises the domain,
 * today's untyped call otherwise).
 *
 * The portal's own modules (`lib/portal/*`, `lib/federation/node-events.ts`,
 * `lib/command-handover.ts`) call the window's command scope
 * (`commandScopeInvoke`, plan item 5004) or an injected invoke, not a
 * negotiated client: {@link nodesApiOver} binds the
 * API to such a call. It carries no `domains`, so it always takes version 0,
 * which sends exactly today's `invoke(command, args)` and returns the answer
 * as sent; the calls are typed by the definitions.
 */
import { nodesClient, type NodesApi } from "@orkestrator/protocol/contract/domains/nodes";
import type { BackendClient } from "@/lib/backend/client";
import { commandScopeInvoke } from "@/lib/portal/command-scope";
import { domainApi } from "./domain-api";
import { backendClientOver, type CommandInvoke } from "./invoke-over";

export type { NodesApi } from "@orkestrator/protocol/contract/domains/nodes";

export function nodesApi(client: BackendClient): NodesApi {
  return domainApi(client, nodesClient);
}

/** A command call in `commandScopeInvoke`'s shape. */
export type NodesInvoke = CommandInvoke;

/** The `nodes` API over a bare command call (version 0: today's untyped call). */
export function nodesApiOver(invoke: NodesInvoke): NodesApi {
  return nodesApi(backendClientOver(invoke));
}

/** The `nodes` API on the window's command scope (the portal APIs). */
export function portalNodesApi(): NodesApi {
  return nodesApiOver(commandScopeInvoke);
}

export { NO_ARGS } from "./invoke-over";
