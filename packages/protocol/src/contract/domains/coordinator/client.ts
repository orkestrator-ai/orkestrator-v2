/**
 * The `coordinator` domain client (plan item 7009; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope and decodes results with the commands'
 *   schemas.
 * - Version 0 (a node that advertises no `coordinator` range: a pre-contract
 *   node, or a client without negotiation) is today's untyped call,
 *   `{ command, args }`, answered as sent (`legacyCommandApi`).
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `coordinator` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { COORDINATOR_COMMANDS } from "./commands.js";
import { coordinatorDomain } from "./domain.js";

export type CoordinatorApi = CommandApi<typeof COORDINATOR_COMMANDS>;

const coordinatorApi = (call: CommandCall): CoordinatorApi =>
  commandApi(call, COORDINATOR_COMMANDS);
const legacyCoordinatorApi = (_call: CommandCall, context: DomainAdapterContext): CoordinatorApi =>
  legacyCommandApi(context, COORDINATOR_COMMANDS);

export const coordinatorClient = domainClient(coordinatorDomain, {
  1: coordinatorApi,
  0: legacyCoordinatorApi,
});
