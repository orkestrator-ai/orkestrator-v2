/**
 * The `graphs` domain client (plan item 7007; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 2 sends the envelope (`requestId` on the launch, restart and code
 *   rewind, `expectedRevision` on the compare-and-swap writes, `digest` on a
 *   duplicate and an edited `value` on a human answer are critical) and
 *   decodes the results with the schemas in `./schemas.ts`.
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
import { GRAPHS_COMMANDS } from "./commands.js";
import { graphsDomain } from "./domain.js";

export type GraphsApi = CommandApi<typeof GRAPHS_COMMANDS>;

const graphsApi = (call: CommandCall): GraphsApi => commandApi(call, GRAPHS_COMMANDS);

export const graphsClient = domainClient(graphsDomain, {
  2: graphsApi,
});
