/**
 * The `nodes` domain client (plan item 7009; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope and decodes results with the commands'
 *   schemas.
 * - Version 0 (a node that advertises no `nodes` range: a pre-contract
 *   node, or a client without negotiation) is today's untyped call,
 *   `{ command, args }`, answered as sent (`legacyCommandApi`).
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `nodes` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { NODES_COMMANDS } from "./commands.js";
import { nodesDomain } from "./domain.js";

export type NodesApi = CommandApi<typeof NODES_COMMANDS>;

const nodesApi = (call: CommandCall): NodesApi => commandApi(call, NODES_COMMANDS);
const legacyNodesApi = (_call: CommandCall, context: DomainAdapterContext): NodesApi =>
  legacyCommandApi(context, NODES_COMMANDS);

export const nodesClient = domainClient(nodesDomain, {
  1: nodesApi,
  0: legacyNodesApi,
});
