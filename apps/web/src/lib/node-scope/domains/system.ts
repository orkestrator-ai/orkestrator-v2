/**
 * The `system` domain on a `lib/backend` factory's client (plan item 7009):
 * `systemApi(client).<command>(args)`. See `./domain-api.ts` for the adapter
 * choice (version 1 with the envelope for a node that advertises the domain,
 * today's untyped call otherwise).
 */
import { systemClient, type SystemApi } from "@orkestrator/protocol/contract/domains/system";
import type { AccountMachine, BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";
import { machineBackendClient } from "@/lib/backend/client";

export type { SystemApi } from "@orkestrator/protocol/contract/domains/system";

export function systemApi(client: BackendClient): SystemApi {
  return domainApi(client, systemClient);
}

/**
 * The `system` domain on `machine` (`AccountMachine`): `undefined` is
 * `client`'s own node (negotiated), `null` the command node over the portal
 * and a node id that node through the command node. A routed call carries no
 * negotiated range, so it uses the version-0 adapter: today's call.
 */
export function systemApiOn(client: BackendClient, machine: AccountMachine): SystemApi {
  return systemApi(machineBackendClient(client, machine));
}

/**
 * A decoded `system` result as the web's own model type: mutable arrays and
 * the literal unions the web narrows to (`environmentType`). The schemas keep
 * the wire values open (`Schema.String`, read-only arrays) so an older
 * client still reads a newer backend; the types converge in plan item 7010.
 */
export function asSystemModel<T>(result: Promise<unknown>): Promise<T> {
  return result as Promise<T>;
}
