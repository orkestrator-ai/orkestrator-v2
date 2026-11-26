/**
 * The `accounts` domain client (plan item 7008; §11.2 "Client adapters"):
 * one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`reauthenticate`, the cancels'
 *   `operationId` and the OpenCode `metadata`/`inputs` are critical) and gets
 *   the shapes the definitions describe.
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26), so a node
 * that advertises no range for the domain is refused with
 * `unsupported-version`. Later bumps keep an adapter for every version a
 * release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import { commandApi, type CommandApi } from "../command-api.js";
import { ACCOUNTS_COMMANDS } from "./commands.js";
import { accountsDomain } from "./domain.js";

export type AccountsApi = CommandApi<typeof ACCOUNTS_COMMANDS>;

const accountsApi = (call: CommandCall): AccountsApi => commandApi(call, ACCOUNTS_COMMANDS);

export const accountsClient = domainClient(accountsDomain, {
  1: accountsApi,
});
