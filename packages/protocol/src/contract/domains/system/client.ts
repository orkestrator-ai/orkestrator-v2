/**
 * The `system` domain client (plan item 7009; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope and decodes results with the commands'
 *   schemas.
 * - Version 0 (a node that advertises no `system` range: a pre-contract
 *   node, or a client without negotiation) is today's untyped call,
 *   `{ command, args }`, answered as sent (`legacyCommandApi`).
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `system` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { SYSTEM_COMMANDS } from "./commands.js";
import { systemDomain } from "./domain.js";

export type SystemApi = CommandApi<typeof SYSTEM_COMMANDS>;

const systemApi = (call: CommandCall): SystemApi => commandApi(call, SYSTEM_COMMANDS);
const legacySystemApi = (_call: CommandCall, context: DomainAdapterContext): SystemApi =>
  legacyCommandApi(context, SYSTEM_COMMANDS);

export const systemClient = domainClient(systemDomain, {
  1: systemApi,
  0: legacySystemApi,
});
