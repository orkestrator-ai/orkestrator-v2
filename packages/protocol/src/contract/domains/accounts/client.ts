/**
 * The `accounts` domain client (plan item 7008; §11.2 "Client adapters"):
 * one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`reauthenticate`, the cancels'
 *   `operationId` and the OpenCode `metadata`/`inputs` are critical) and gets
 *   the shapes the definitions describe.
 * - Version 0 (a pre-contract node) is today's untyped call, answered as sent
 *   (`legacyCommandApi`). No accounts command was gated by a capability: a
 *   node that predates one answers `unknown-command`, which the callers read
 *   with `incompatibility()` as before (the switch grant reads as `null`, the
 *   preferred identity and host sign-ins as unavailable). Every build that
 *   advertises the domain has all of them.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `accounts` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { ACCOUNTS_COMMANDS } from "./commands.js";
import { accountsDomain } from "./domain.js";

export type AccountsApi = CommandApi<typeof ACCOUNTS_COMMANDS>;

const accountsApi = (call: CommandCall): AccountsApi => commandApi(call, ACCOUNTS_COMMANDS);
const legacyAccountsApi = (_call: CommandCall, context: DomainAdapterContext): AccountsApi =>
  legacyCommandApi(context, ACCOUNTS_COMMANDS);

export const accountsClient = domainClient(accountsDomain, {
  1: accountsApi,
  0: legacyAccountsApi,
});
