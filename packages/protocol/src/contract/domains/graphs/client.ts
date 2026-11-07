/**
 * The `graphs` domain client (plan item 7007; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`requestId` on the launch, restart and code
 *   rewind, `expectedRevision` on the compare-and-swap writes, `digest` on a
 *   duplicate and an edited `value` on a human answer are critical) and
 *   decodes the results with the schemas in `./schemas.ts`.
 * - Version 0 (a pre-contract node) is today's untyped call, answered as
 *   sent (`legacyCommandApi`). No graph command was capability-gated.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `graphs` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { GRAPHS_COMMANDS } from "./commands.js";
import { graphsDomain } from "./domain.js";

export type GraphsApi = CommandApi<typeof GRAPHS_COMMANDS>;

const graphsApi = (call: CommandCall): GraphsApi => commandApi(call, GRAPHS_COMMANDS);
const legacyGraphsApi = (_call: CommandCall, context: DomainAdapterContext): GraphsApi =>
  legacyCommandApi(context, GRAPHS_COMMANDS);

export const graphsClient = domainClient(graphsDomain, {
  1: graphsApi,
  0: legacyGraphsApi,
});
