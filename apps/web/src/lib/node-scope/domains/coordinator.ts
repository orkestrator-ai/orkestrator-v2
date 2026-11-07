/**
 * The `coordinator` domain on a `lib/backend` factory's client (plan item 7009):
 * `coordinatorApi(client).<command>(args)`. See `./domain-api.ts` for the adapter
 * choice (version 1 with the envelope for a node that advertises the domain,
 * today's untyped call otherwise).
 */
import {
  coordinatorClient,
  type CoordinatorApi,
} from "@orkestrator/protocol/contract/domains/coordinator";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { CoordinatorApi } from "@orkestrator/protocol/contract/domains/coordinator";

export function coordinatorApi(client: BackendClient): CoordinatorApi {
  return domainApi(client, coordinatorClient);
}
