/**
 * The `nodes` domain client (plan item 7009; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope and decodes results with the commands'
 *   schemas.
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26). A domains map
 * that omits this domain yields `unsupported-version`. Without a domains
 * map, calls use the lowest adapter unnegotiated. Later bumps keep an
 * adapter for every version a release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import { commandApi, type CommandApi } from "../command-api.js";
import { NODES_COMMANDS } from "./commands.js";
import { nodesDomain } from "./domain.js";

export type NodesApi = CommandApi<typeof NODES_COMMANDS>;

const nodesApi = (call: CommandCall): NodesApi => commandApi(call, NODES_COMMANDS);

export const nodesClient = domainClient(nodesDomain, {
  1: nodesApi,
});
