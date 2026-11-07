/**
 * The `nodes` domain on a `lib/backend` factory's client (plan item 7009):
 * `nodesApi(client).<command>(args)`. See `./domain-api.ts` for the adapter
 * choice (version 1 with the envelope for a node that advertises the domain,
 * today's untyped call otherwise).
 */
import { nodesClient, type NodesApi } from "@orkestrator/protocol/contract/domains/nodes";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { NodesApi } from "@orkestrator/protocol/contract/domains/nodes";

export function nodesApi(client: BackendClient): NodesApi {
  return domainApi(client, nodesClient);
}
