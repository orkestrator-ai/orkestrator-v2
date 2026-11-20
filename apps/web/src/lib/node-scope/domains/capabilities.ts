/**
 * The `capabilities` domain on a `lib/backend` factory's client:
 * `capabilitiesOn(client).list_capability_packages({})`.
 *
 * Agent Capabilities belong to the command node (it holds the fleet's
 * setups), so callers use the window's command scope client. The client's
 * own node picks the adapter from its negotiated `domains`; a node that
 * predates the domain answers `unknown-command`, which the page shows as
 * "this machine's Orkestrator is too old to manage capabilities". Calls keep
 * the arguments object `machineInvoke` always sent (`withArgumentsObject`).
 * See `./domain-api.ts`.
 */
import {
  capabilitiesClient,
  type CapabilitiesApi,
} from "@orkestrator/protocol/contract/domains/capabilities";
import type { BackendClient } from "@/lib/backend/client";
import { withArgumentsObject } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { CapabilitiesApi } from "@orkestrator/protocol/contract/domains/capabilities";

/** The `capabilities` API through `client`, made once per call site. */
export function capabilitiesOn(client: BackendClient): CapabilitiesApi {
  return domainApi(withArgumentsObject(client), capabilitiesClient);
}
