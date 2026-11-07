/**
 * The `graphs` domain on a `lib/backend` factory's client (plan item 7007):
 * `graphs(client).graph_run_get({ runId })`. See `./domain-api.ts` for the
 * adapter choice. The machine-aware graph functions aim the client first
 * (`graphsOn`), so a call routed to another machine, or to the command node
 * over the portal, carries no negotiated range and takes version 0: today's
 * call by name.
 */
import { graphsClient, type GraphsApi } from "@orkestrator/protocol/contract/domains/graphs";
import type { AccountMachine, BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";
import { machineBackendClient } from "@/lib/backend/client";

export type { GraphsApi } from "@orkestrator/protocol/contract/domains/graphs";

export function graphs(client: BackendClient): GraphsApi {
  return domainApi(client, graphsClient);
}

/** The `graphs` API on `machine` (`AccountMachine`; `undefined` is `client`'s own node). */
export function graphsOn(client: BackendClient, machine: AccountMachine): GraphsApi {
  return graphs(machineBackendClient(client, machine));
}
