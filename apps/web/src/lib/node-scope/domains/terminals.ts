/**
 * The `terminals` domain on a `lib/backend` factory's client (plan item
 * 7002): `terminals(client).terminal_write({ sessionId, data })`. See
 * `./domain-api.ts` for the adapter choice and the hot path.
 */
import {
  terminalsClient,
  type TerminalsApi,
} from "@orkestrator/protocol/contract/domains/terminals";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { TerminalsApi } from "@orkestrator/protocol/contract/domains/terminals";

export function terminals(client: BackendClient): TerminalsApi {
  return domainApi(client, terminalsClient);
}
