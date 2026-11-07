/**
 * The `terminals` domain client (plan item 7002; §11.2 "Client adapters"):
 * one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`requestId` on `launch_terminal_job` is
 *   critical) and gets the shapes the definitions describe.
 * - Version 0 (a pre-contract node) is today's untyped call, `{ command,
 *   args }`, answered as sent (`legacyCommandApi`). No terminal command was
 *   ever capability-gated: what a pre-contract node needs is in its answers
 *   (`bootstrapped` and `truncated` absent, no `delivered` from
 *   `terminal_write`), which the callers in `lib/backend/terminals.ts`
 *   already default. The result schemas accept those older forms too.
 *
 * `hotPath` commands (input, resize, output reads) skip result decoding in a
 * production renderer (`validateHotPathResults`).
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `terminals` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { TERMINALS_COMMANDS } from "./commands.js";
import { terminalsDomain } from "./domain.js";

export type TerminalsApi = CommandApi<typeof TERMINALS_COMMANDS>;

const terminalsApi = (call: CommandCall): TerminalsApi => commandApi(call, TERMINALS_COMMANDS);
const legacyTerminalsApi = (_call: CommandCall, context: DomainAdapterContext): TerminalsApi =>
  legacyCommandApi(context, TERMINALS_COMMANDS);

export const terminalsClient = domainClient(terminalsDomain, {
  1: terminalsApi,
  0: legacyTerminalsApi,
});
