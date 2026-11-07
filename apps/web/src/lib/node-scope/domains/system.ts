/**
 * The `system` domain on a `lib/backend` factory's client (plan item 7009):
 * `systemApi(client).<command>(args)`. See `./domain-api.ts` for the adapter
 * choice (version 1 with the envelope for a node that advertises the domain,
 * today's untyped call otherwise).
 */
import { systemClient, type SystemApi } from "@orkestrator/protocol/contract/domains/system";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { SystemApi } from "@orkestrator/protocol/contract/domains/system";

export function systemApi(client: BackendClient): SystemApi {
  return domainApi(client, systemClient);
}
