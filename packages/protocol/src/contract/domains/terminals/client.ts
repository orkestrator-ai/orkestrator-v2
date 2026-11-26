/**
 * The `terminals` domain client (plan item 7002; §11.2 "Client adapters"):
 * one function per command (`commandApi`), keyed by command name.
 *
 * - Version 2 sends the envelope (`requestId` on `launch_terminal_job` is
 *   critical) and gets the shapes the definitions describe.
 *
 * `hotPath` commands (input, resize, output reads) skip result decoding in a
 * production renderer (`validateHotPathResults`).
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
import { TERMINALS_COMMANDS } from "./commands.js";
import { terminalsDomain } from "./domain.js";

export type TerminalsApi = CommandApi<typeof TERMINALS_COMMANDS>;

const terminalsApi = (call: CommandCall): TerminalsApi => commandApi(call, TERMINALS_COMMANDS);

export const terminalsClient = domainClient(terminalsDomain, {
  2: terminalsApi,
});
